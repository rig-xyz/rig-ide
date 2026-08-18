import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigAccountError, RigUser, RigWorkspaceBinding } from '@shared/rig/account';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';

/**
 * Account-scoped relay reads: who the signed-in user is (`GET /v1/me`) and
 * which workspaces they're a member of (`GET /v1/me/bindings`). No workspace
 * is involved in resolving either — this is the account-scoped counterpart to
 * `comments.ts`, which is workspace-scoped.
 *
 * SECURITY: `comments.ts` reads its relay URL from the workspace's own
 * `.rig/tap-binding.local.json` — repo-controlled content — and gates it
 * through `checkRelayTrust` before attaching the PAT, because a malicious
 * checkout could otherwise point that file at an attacker's host and walk off
 * with the user's token. This module has no workspace and therefore no such
 * file, but that does not make the token safe to just send: `RIG_RELAY_URL`
 * is user/environment-settable too, so the same gate applies to the default
 * URL below. "May the PAT go here" stays the one rule it always is, with no
 * carve-out for "there's nothing to lie about it this time."
 */

const REQUEST_TIMEOUT_MS = 10_000;

/** Mirrors the rig CLI's own default — see src/config.mjs:87 in the rig repo. */
const DEFAULT_RELAY_URL = 'https://tap-relay.fly.dev';

/** Pure so it can be unit-tested without touching the real environment. */
export function resolveRelayUrl(envUrl: string | undefined = process.env.RIG_RELAY_URL): string {
  return envUrl?.trim() || DEFAULT_RELAY_URL;
}

const NOT_SIGNED_IN: RigAccountError = {
  kind: 'notSignedIn',
  message: 'Not signed in to Rig.',
};

type Resolved = { url: string; token: string };

/**
 * The trust gate on the user's PAT (see `relay-trust.ts`), applied to
 * `resolveRelayUrl()` before the token is ever read. The only place a
 * `Resolved` — and with it the token — is minted, so every relay call in this
 * module is behind it.
 */
async function resolveContext(): Promise<Resolved | RigAccountError> {
  const url = resolveRelayUrl();
  const trust = checkRelayTrust(url);
  if (!trust.trusted) {
    log.warn('Rig account: refusing to send the relay token to an untrusted host', {
      host: trust.host,
    });
    return {
      kind: 'untrustedRelay',
      host: trust.host,
      message: `RIG_RELAY_URL points at an unrecognized relay (${trust.host}) — refusing to send your sign-in token there.`,
    };
  }
  const token = await readRelayToken();
  if (!token) return NOT_SIGNED_IN;
  return { url, token };
}

function isError(value: Resolved | RigAccountError): value is RigAccountError {
  return 'kind' in value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

async function relayGet(ctx: Resolved, path: string): Promise<Response> {
  const base = ctx.url.replace(/\/+$/, '');
  return fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function transportError(action: string, error: unknown): RigAccountError {
  log.warn('Rig account relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
}

async function relayError(response: Response, action: string): Promise<RigAccountError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    const raw = asRecord(body)?.error;
    if (typeof raw === 'string') code = raw;
  } catch {
    // non-JSON body; the status alone has to do
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

/**
 * `{ user: {...} }` from `GET /v1/me`. `name`/`avatarUrl` are recent
 * additions the relay may not send yet — both degrade to null rather than
 * being dropped or throwing.
 */
export function toUser(value: unknown): RigUser | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string' || typeof raw.clerkUserId !== 'string') return null;
  return {
    id: raw.id,
    clerkUserId: raw.clerkUserId,
    // Null, not '': the relay really does return `email: null`, and an empty
    // string survives `??` and lands in the UI as a blank label.
    email: typeof raw.email === 'string' && raw.email.length > 0 ? raw.email : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

/**
 * One row of `{ bindings: [{ binding: {...}, role, lastSyncedAt }] }` from
 * `GET /v1/me/bindings`. `relayHost` is not part of the payload — every
 * binding this route returns lives on the relay the request was made to, so
 * it's filled in from `ctx.url` by the caller.
 */
export function toBinding(value: unknown, relayHost: string): RigWorkspaceBinding | null {
  const raw = asRecord(value);
  const binding = asRecord(raw?.binding);
  if (!binding || typeof binding.id !== 'string' || typeof binding.name !== 'string') return null;
  return {
    id: binding.id,
    name: binding.name,
    role: typeof raw?.role === 'string' ? raw.role : 'viewer',
    lastSyncedAt: typeof raw?.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
    createdAt: typeof binding.createdAt === 'string' ? binding.createdAt : '',
    relayHost,
  };
}

/**
 * Every method returns a Result and never throws across the IPC boundary, so
 * the renderer can always render *something*. No PAT ever appears in a log
 * line.
 */
export const rigAccountController = createRPCController({
  /** `GET /v1/me` — who the signed-in user is. */
  me: async (): Promise<Result<RigUser, RigAccountError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    let response: Response;
    try {
      response = await relayGet(ctx, '/v1/me');
    } catch (error) {
      return err(transportError('load your account', error));
    }
    if (!response.ok) return err(await relayError(response, 'load your account'));

    try {
      const data = asRecord(await response.json());
      const user = toUser(data?.user);
      if (!user) {
        return err<RigAccountError>({ kind: 'relay', message: 'Could not load your account.' });
      }
      return ok(user);
    } catch (error) {
      return err(transportError('load your account', error));
    }
  },

  /** `GET /v1/me/bindings` — every workspace the signed-in user is a member of. */
  workspaces: async (): Promise<Result<RigWorkspaceBinding[], RigAccountError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    let response: Response;
    try {
      response = await relayGet(ctx, '/v1/me/bindings');
    } catch (error) {
      return err(transportError('load your workspaces', error));
    }
    if (!response.ok) return err(await relayError(response, 'load your workspaces'));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.bindings) ? data.bindings : [];
      const relayHost = new URL(ctx.url).host;
      const bindings = raw
        .map((row) => toBinding(row, relayHost))
        .filter((binding): binding is RigWorkspaceBinding => binding !== null);
      return ok(bindings);
    } catch (error) {
      return err(transportError('load your workspaces', error));
    }
  },
});
