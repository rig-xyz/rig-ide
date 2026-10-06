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
  /** Who you're signed in as at the vendor (an email or username), when its server says. */
  login?: string;
  /** When rig last asked and got no answer (so such a server isn't asked on every list; retried after a day). */
  loginTriedAt?: number;
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
  /** Asks the connector's own server who the token belongs to. Default: its "who am I" MCP tool. */
  identify?: (id: ConnectorId, url: string, accessToken: string) => Promise<string | null>;
}

/**
 * What a session gets: the servers to hand the agent, the space's connectors
 * it can't reach, and (optionally) the space's connectors it already has from
 * its own global setup, which are never gaps.
 */
export type SessionConnectors = {
  servers: AcpMcpServerWire[];
  gaps: ConnectorGap[];
  global?: ConnectorId[];
  /** The folder's own `.mcp.json` servers held back from this session (Claude only: Codex's get handed over in `servers`), and the ones waiting for your Allow (see project-servers.ts). */
  project?: { disabled: string[]; pending: string[] };
};

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
  const identify = deps.identify ?? identifyViaMcp;
  /** One lookup in flight per connection. */
  const identifying = new Set<string>();

  /** Best effort, never blocks a connect or a list: remembers who you're signed in as. */
  async function learnLogin(account: string, id: ConnectorId): Promise<void> {
    const key = secretKey(account, id);
    if (identifying.has(key)) return;
    identifying.add(key);
    try {
      const token = await freshAccessToken(account, id);
      if (!token) return;
      const login = await identify(id, connectorById(id)!.url, token).catch(() => null);
      const stored = await read(account, id);
      if (stored?.tokens) await write(account, id, { ...stored, loginTriedAt: now(), ...(login ? { login } : {}) });
    } finally {
      identifying.delete(key);
    }
  }
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
      // An OpenID id_token says who you are straight away; otherwise ask the server.
      const fromIdToken = tokens.id_token ? loginFromIdToken(tokens.id_token) : null;
      await write(account, id, { issuer, clients, tokens: toTokens(tokens), ...(fromIdToken ? { login: fromIdToken } : {}) });
      if (!fromIdToken) void learnLogin(account, id);
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
        CONNECTORS.map(async (c): Promise<ConnectionStatus> => {
          const stored = account ? await read(account, c.id) : null;
          const state = stateOf(stored);
          // Connections made before rig asked (or while the server was down): ask once, in the background.
          const askedRecently = stored?.loginTriedAt !== undefined && now() - stored.loginTriedAt < LOGIN_RETRY_MS;
          if (account && state === 'connected' && !stored?.login && !askedRecently) void learnLogin(account, c.id);
          return { id: c.id, state, ...(stored?.login ? { account: stored.login } : {}) };
        })
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

/** The email (or username) claim of an OpenID id_token. Display only: not verified, never trusted for access. */
export function loginFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const key of ['email', 'preferred_username', 'name']) {
      const value = claims[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // Not a JWT we can read: fall back to asking the server.
  }
  return null;
}

/** Known "who am I" tools; any other server gets a name-based guess (a tool that takes no arguments). */
const WHOAMI_TOOLS: Partial<Record<ConnectorId, { tool: string; args?: Record<string, unknown> }>> = {
  linear: { tool: 'get_user', args: { query: 'me' } },
  sentry: { tool: 'whoami' },
  // Checked 2026-09-25: returns your own person record, with email.
  notion: { tool: 'notion-get-users', args: { user_id: 'self' } },
  atlassian: { tool: 'atlassianUserInfo' },
};
const WHOAMI_NAME =
  /^(?:[a-z0-9]+[-_.])?(?:whoami|who[-_]?am[-_]?i|get[-_]?me|get[-_]?self|me|self|get[-_]?current[-_]?user|current[-_]?user|get[-_]?viewer|viewer|user[-_]?info|get[-_]?user[-_]?info)$/i;
const IDENTIFY_TIMEOUT_MS = 15_000;
/** How long to wait before asking a server that had no answer again. */
const LOGIN_RETRY_MS = 24 * 60 * 60 * 1000;

/** The account behind a token, from the vendor's own MCP server: an email when it shows one, else a username or name. */
export function pickLogin(payload: unknown): string | null {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0];
  if (email) return email;
  let data: unknown = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const find = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== 'object' || depth > 3) return null;
    const record = value as Record<string, unknown>;
    for (const key of ['username', 'login', 'handle', 'displayName', 'display_name', 'name']) {
      const v = record[key];
      if (typeof v === 'string' && v.trim() && v.length <= 120) return v.trim();
    }
    for (const v of Object.values(record)) {
      const hit = find(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return find(data, 0);
}

async function identifyViaMcp(id: ConnectorId, url: string, accessToken: string): Promise<string | null> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const client = new Client({ name: 'rig', version: '1' });
  const signal = AbortSignal.timeout(IDENTIFY_TIMEOUT_MS);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` }, signal },
      })
    );
    const known = WHOAMI_TOOLS[id];
    let call: { name: string; arguments: Record<string, unknown> } | null = known
      ? { name: known.tool, arguments: known.args ?? {} }
      : null;
    if (!call) {
      const { tools } = await client.listTools(undefined, { signal });
      const guess = tools.find(
        (t) => WHOAMI_NAME.test(t.name) && !((t.inputSchema as { required?: unknown[] })?.required?.length)
      );
      if (guess) call = { name: guess.name, arguments: {} };
      // Once a day at most per connection (loginTriedAt): which tools it has, to map its "who am I" by hand. Names only.
      else log.warn('Rig connectors: no "who am I" tool found', { id, tools: tools.map((t) => t.name) });
    }
    if (!call) return null;
    const result = await client.callTool(call, undefined, { signal });
    if (result.isError) return null;
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
    return pickLogin(result.structuredContent ?? text) ?? pickLogin(text);
  } catch (error) {
    log.info('Rig connectors: could not learn which account a login belongs to', { id, error: String(error) });
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
