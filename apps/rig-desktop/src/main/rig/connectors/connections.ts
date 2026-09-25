import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AcpMcpServerWire } from '@emdash/core/acp';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from '@main/lib/logger';
import {
  CONNECTORS,
  connectorById,
  mcpServerName,
  type ConnectionState,
  type ConnectionStatus,
  type ConnectorGap,
  type ConnectorId,
  type ConnectResult,
} from '@shared/spaces/connectors';

/**
 * Your own logins to the space connectors (Linear, Notion…), on this machine.
 * See rig/docs/connectors-spec.md.
 *
 * Rig runs the vendor's standard MCP OAuth itself: discovery, dynamic client
 * registration (as a public client), PKCE, a one-shot loopback redirect, and
 * refresh. Tokens are kept encrypted in the app's secret store, keyed by rig
 * account, and only ever leave this process as an `Authorization` header on
 * the MCP server handed to your own agent's session. Never logged, never sent
 * to the relay.
 */

const CALLBACK_PATH = '/connectors/callback';
/** Fixed first, so the registration made once per install keeps matching. */
const CALLBACK_PORTS = [33418, 33419, 33420, 33421];
const CONNECT_TIMEOUT_MS = 5 * 60_000;
/** Refresh a token that has less than this left before handing it to a session. */
const REFRESH_MARGIN_MS = 5 * 60_000;

type StoredClient = { clientId: string; clientSecret?: string; redirectUri: string };

/** Everything kept for one connection, as one encrypted secret. */
type StoredConnection = {
  /** The authorization server the tokens came from. */
  issuer: string;
  clients: StoredClient[];
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number } | null;
  /** Set when a refresh was refused: the login needs redoing. */
  expired?: boolean;
};

export interface ConnectionSecrets {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, secret: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/** The OAuth steps, injectable so tests never touch the network. Defaults: the MCP SDK. */
export interface OAuthSteps {
  discover(resourceUrl: string): Promise<{ issuer: string; metadata: AuthorizationServerMetadata }>;
  register(issuer: string, metadata: AuthorizationServerMetadata, redirectUri: string): Promise<StoredClient>;
  authorizeUrl(
    issuer: string,
    metadata: AuthorizationServerMetadata,
    client: StoredClient,
    state: string,
    resourceUrl: string
  ): Promise<{ url: string; codeVerifier: string }>;
  exchange(
    issuer: string,
    metadata: AuthorizationServerMetadata,
    client: StoredClient,
    code: string,
    codeVerifier: string,
    resourceUrl: string
  ): Promise<OAuthTokens>;
  refresh(
    issuer: string,
    metadata: AuthorizationServerMetadata,
    client: StoredClient,
    refreshToken: string,
    resourceUrl: string
  ): Promise<OAuthTokens>;
}

/** A one-shot local listener for the vendor's redirect back to rig. */
export interface CallbackListener {
  redirectUri: string;
  /** Resolves with the redirect's query parameters. */
  wait: Promise<URLSearchParams>;
  close(): void;
}

export interface ConnectionsDeps {
  secrets: ConnectionSecrets;
  /** The signed-in rig account, or null when signed out (then nothing is connected). */
  accountId: () => Promise<string | null>;
  openBrowser: (url: string) => Promise<void>;
  oauth?: OAuthSteps;
  listen?: () => Promise<CallbackListener>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * What a session gets: the servers to hand the agent, the space's connectors
 * it can't reach, and (optionally) the space's connectors it already has from
 * its own global setup, which are never gaps.
 */
export type SessionConnectors = { servers: AcpMcpServerWire[]; gaps: ConnectorGap[]; global?: ConnectorId[] };

export interface Connections {
  list(): Promise<ConnectionStatus[]>;
  connect(id: ConnectorId): Promise<ConnectResult>;
  cancel(id: ConnectorId): void;
  disconnect(id: ConnectorId): Promise<void>;
  /** Servers (with fresh tokens) for the given connectors, plus the ones you haven't connected or whose login lapsed. */
  forSession(ids: readonly ConnectorId[]): Promise<SessionConnectors>;
}

const secretKey = (account: string, id: ConnectorId) => `connectors:${account}:${id}`;

export function createConnections(deps: ConnectionsDeps): Connections {
  const oauth = deps.oauth ?? sdkOAuthSteps;
  const listen = deps.listen ?? listenOnLoopback;
  const now = deps.now ?? Date.now;
  /** The one sign-in in flight (the callback port is shared, so one at a time). */
  let inFlight: { id: ConnectorId; abort: (result: ConnectResult) => void } | null = null;

  async function read(account: string, id: ConnectorId): Promise<StoredConnection | null> {
    try {
      const raw = await deps.secrets.getSecret(secretKey(account, id));
      return raw ? (JSON.parse(raw) as StoredConnection) : null;
    } catch (error) {
      log.warn('Rig connectors: could not read a stored connection', { id, error: String(error) });
      return null;
    }
  }

  async function write(account: string, id: ConnectorId, value: StoredConnection): Promise<void> {
    await deps.secrets.setSecret(secretKey(account, id), JSON.stringify(value));
  }

  function stateOf(stored: StoredConnection | null): ConnectionState {
    if (!stored?.tokens) return 'not_connected';
    if (stored.expired) return 'expired';
    const { expiresAt, refreshToken } = stored.tokens;
    if (expiresAt !== undefined && expiresAt <= now() && !refreshToken) return 'expired';
    return 'connected';
  }

  function toTokens(tokens: OAuthTokens, previous?: StoredConnection['tokens']): NonNullable<StoredConnection['tokens']> {
    return {
      accessToken: tokens.access_token,
      // Some servers rotate refresh tokens, some don't send one back on refresh.
      refreshToken: tokens.refresh_token ?? previous?.refreshToken,
      expiresAt: typeof tokens.expires_in === 'number' ? now() + tokens.expires_in * 1000 : undefined,
    };
  }

  async function signIn(account: string, id: ConnectorId, signal: Promise<ConnectResult>): Promise<ConnectResult> {
    const connector = connectorById(id)!;
    const { issuer, metadata } = await oauth.discover(connector.url);
    const stored = await read(account, id);
    const listener = await listen();
    try {
      // One registration per redirect (i.e. per port), reused across sign-ins.
      const clients = stored?.issuer === issuer ? stored.clients : [];
      let client = clients.find((c) => c.redirectUri === listener.redirectUri);
      if (!client) {
        client = await oauth.register(issuer, metadata, listener.redirectUri);
        clients.push(client);
        await write(account, id, { issuer, clients, tokens: stored?.issuer === issuer ? stored.tokens : null });
      }
      const state = randomUUID();
      const { url, codeVerifier } = await oauth.authorizeUrl(issuer, metadata, client, state, connector.url);
      await deps.openBrowser(url);

      const outcome = await Promise.race([
        listener.wait.then((params) => ({ params })),
        signal.then((result) => ({ result })),
      ]);
      if ('result' in outcome) return outcome.result;
      const { params } = outcome;
      if (params.get('state') !== state) return { ok: false, reason: 'failed', message: "The sign-in didn't match; try again." };
      const denied = params.get('error');
      if (denied) {
        return denied === 'access_denied'
          ? { ok: false, reason: 'denied' }
          : { ok: false, reason: 'failed', message: params.get('error_description') ?? denied };
      }
      const code = params.get('code');
      if (!code) return { ok: false, reason: 'failed', message: 'The sign-in came back without a code.' };

      const tokens = await oauth.exchange(issuer, metadata, client, code, codeVerifier, connector.url);
      await write(account, id, { issuer, clients, tokens: toTokens(tokens) });
      log.info('Rig connectors: connected', { id });
      return { ok: true };
    } finally {
      listener.close();
    }
  }

  /** Fresh tokens for one connection, refreshing when close to expiry. Null = can't be used. */
  async function freshAccessToken(account: string, id: ConnectorId): Promise<string | null> {
    const stored = await read(account, id);
    if (!stored?.tokens || stored.expired) return null;
    const { accessToken, refreshToken, expiresAt } = stored.tokens;
    if (expiresAt === undefined || expiresAt - now() > REFRESH_MARGIN_MS) return accessToken;
    if (!refreshToken) return expiresAt > now() ? accessToken : null;
    const client = stored.clients[stored.clients.length - 1];
    if (!client) return null;
    const connector = connectorById(id)!;
    try {
      const { metadata } = await oauth.discover(connector.url);
      const tokens = await oauth.refresh(stored.issuer, metadata, client, refreshToken, connector.url);
      const next = toTokens(tokens, stored.tokens);
      await write(account, id, { ...stored, tokens: next, expired: false });
      return next.accessToken;
    } catch (error) {
      log.warn('Rig connectors: could not refresh a login', { id, error: String(error) });
      // Still valid for a few minutes? Use it; the next session retries the refresh.
      if (expiresAt > now()) return accessToken;
      await write(account, id, { ...stored, expired: true });
      return null;
    }
  }

  return {
    async list() {
      const account = await deps.accountId();
      return Promise.all(
        CONNECTORS.map(async (c) => ({
          id: c.id,
          state: account ? stateOf(await read(account, c.id)) : ('not_connected' as const),
        }))
      );
    },

    async connect(id) {
      const account = await deps.accountId();
      if (!account) return { ok: false, reason: 'failed', message: 'Sign in to Rig first.' };
      inFlight?.abort({ ok: false, reason: 'cancelled' });
      let abort!: (result: ConnectResult) => void;
      const signal = new Promise<ConnectResult>((resolve) => (abort = resolve));
      const mine = { id, abort };
      inFlight = mine;
      const timer = setTimeout(() => abort({ ok: false, reason: 'timeout' }), deps.timeoutMs ?? CONNECT_TIMEOUT_MS);
      try {
        return await signIn(account, id, signal);
      } catch (error) {
        log.warn('Rig connectors: sign-in failed', { id, error: String(error) });
        return { ok: false, reason: 'failed', message: String((error as Error)?.message ?? error) };
      } finally {
        clearTimeout(timer);
        if (inFlight === mine) inFlight = null;
      }
    },

    cancel(id) {
      if (inFlight?.id === id) inFlight.abort({ ok: false, reason: 'cancelled' });
    },

    async disconnect(id) {
      const account = await deps.accountId();
      if (!account) return;
      await deps.secrets.deleteSecret(secretKey(account, id));
      log.info('Rig connectors: disconnected', { id });
    },

    async forSession(ids) {
      const account = await deps.accountId();
      const servers: AcpMcpServerWire[] = [];
      const gaps: ConnectorGap[] = [];
      for (const id of ids) {
        const connector = connectorById(id);
        if (!connector) continue;
        const stored = account ? await read(account, id) : null;
        const token = account && stored?.tokens ? await freshAccessToken(account, id) : null;
        if (!token) {
          gaps.push({ id, state: stored?.tokens ? 'expired' : 'not_connected' });
          continue;
        }
        servers.push({
          type: 'http',
          name: mcpServerName(id),
          url: connector.url,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        });
      }
      return { servers, gaps };
    },
  };
}

const sdkOAuthSteps: OAuthSteps = {
  async discover(resourceUrl) {
    let issuer = new URL(resourceUrl).origin;
    try {
      const resource = await discoverOAuthProtectedResourceMetadata(resourceUrl);
      issuer = String(resource.authorization_servers?.[0] ?? issuer);
    } catch {
      // No protected-resource metadata: the MCP server's own origin is the issuer.
    }
    const metadata = await discoverAuthorizationServerMetadata(issuer);
    if (!metadata) throw new Error(`No sign-in metadata at ${issuer}`);
    return { issuer, metadata };
  },

  async register(issuer, metadata, redirectUri) {
    const info = await registerClient(issuer, {
      metadata,
      clientMetadata: {
        client_name: 'Rig',
        client_uri: 'https://userig.xyz',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    return {
      clientId: info.client_id,
      ...(info.client_secret ? { clientSecret: info.client_secret } : {}),
      redirectUri,
    };
  },

  async authorizeUrl(issuer, metadata, client, state, resourceUrl) {
    const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
      metadata,
      clientInformation: toClientInformation(client),
      redirectUrl: client.redirectUri,
      state,
      resource: new URL(resourceUrl),
    });
    return { url: authorizationUrl.href, codeVerifier };
  },

  exchange(issuer, metadata, client, code, codeVerifier, resourceUrl) {
    return exchangeAuthorization(issuer, {
      metadata,
      clientInformation: toClientInformation(client),
      authorizationCode: code,
      codeVerifier,
      redirectUri: client.redirectUri,
      resource: new URL(resourceUrl),
    });
  },

  refresh(issuer, metadata, client, refreshToken, resourceUrl) {
    return refreshAuthorization(issuer, {
      metadata,
      clientInformation: toClientInformation(client),
      refreshToken,
      resource: new URL(resourceUrl),
    });
  },
};

function toClientInformation(client: StoredClient) {
  return { client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
}

const CALLBACK_PAGE = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>Rig</title><body style="font:15px system-ui;margin:48px;color:#222">${
    ok ? 'Connected. You can close this tab and go back to Rig.' : "Didn't connect. You can close this tab and try again in Rig."
  }</body>`;

/** Listens on the first free fixed loopback port for the one redirect back from the vendor. */
async function listenOnLoopback(): Promise<CallbackListener> {
  for (const port of CALLBACK_PORTS) {
    const server = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!bound) continue;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const wait = new Promise<URLSearchParams>((resolve) => {
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.has('code') && !url.searchParams.has('error');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CALLBACK_PAGE(ok));
        resolve(url.searchParams);
      });
    });
    return { redirectUri, wait, close: () => closeQuietly(server) };
  }
  throw new Error('No free local port for the sign-in to come back to.');
}

function closeQuietly(server: Server): void {
  server.close();
  server.closeAllConnections?.();
}
