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

// Generous on purpose: a slow network that would still answer must not read
// as "offline" (Home shows a "still connecting" hint while it waits).
const REQUEST_TIMEOUT_MS = 30_000;

/** Mirrors the rig CLI's own default — see src/config.mjs:87 in the rig repo. */
const DEFAULT_RELAY_URL = 'https://tap-relay.fly.dev';

/** Pure so it can be unit-tested without touching the real environment. */
export function resolveRelayUrl(envUrl: string | undefined = process.env.RIG_RELAY_URL): string {
  return envUrl?.trim() || DEFAULT_RELAY_URL;
}

/**
 * The account identity to inject into a spawned CLI process's own
 * environment — both the direct `rig` CLI (`create.ts`, `join.ts`,
 * `rig-controls.ts` via `create.ts`'s `runRig`) and the ACP-driven agent CLI
 * (comment `@mention` sessions, via the ACP host) — so a spawned CLI always
 * acts as the SAME account as the app, never a stale `RIG_RELAY_TOKEN` it
 * happened to inherit from the user's shell.
 *
 * The rig CLI's own token reader (`src/config.mjs`'s `getRelayToken`)
 * deliberately prefers its environment over its config file (scripts/CI set
 * it on purpose) — so agreement with the app can only come from the app
 * overwriting that env var itself with whatever `readRelayToken()` resolves,
 * not from asking the CLI to adopt the app's config-file-first precedence.
 *
 * Read fresh on every call — same reasoning as `readRelayToken` — so a
 * mid-session sign-in takes effect on the very next spawn, no restart
 * needed. `RIG_RELAY_TOKEN` is omitted entirely (not set to an empty
 * string) when there's no token yet: an unauthenticated spawn should see
 * whatever the environment already provided, not an explicit override to
 * nothing.
 */
export async function resolveCliAccountEnv(): Promise<Record<string, string>> {
  const token = await readRelayToken();
  return {
    RIG_RELAY_URL: resolveRelayUrl(),
    ...(token ? { RIG_RELAY_TOKEN: token } : {}),
  };
}

const NOT_SIGNED_IN: RigAccountError = {
  kind: 'notSignedIn',
  message: 'Not signed in to Rig.',
};

export type Resolved = { url: string; token: string };

/**
 * The trust gate on the user's PAT (see `relay-trust.ts`), applied to
 * `resolveRelayUrl()` before the token is ever read. The only place a
 * `Resolved` — and with it the token — is minted, so every relay call in this
 * module is behind it.
 *
 * Exported for `rig/spaces/*` (lane 3): the session publisher, request
 * claimer, and space connection-info RPC all need the exact same
 * trust-gated `{url, token}` this module already resolves for `me()`/
 * `workspaces()` — re-deriving the trust gate a second time would risk the
 * two copies drifting apart.
 */
export async function resolveContext(): Promise<Resolved | RigAccountError> {
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

export function isError(value: Resolved | RigAccountError): value is RigAccountError {
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
  // The relay's signal that the token on disk is dead (revoked, expired, or
  // simply not what it thinks the caller is anymore) — distinct from every
  // other relay error because the renderer treats it as "signed out," not
  // just "this one request failed" (see `deriveSignedIn` in
  // `renderer/features/rig-account/auth-state.ts`, driven by the `me` query).
  if (response.status === 401 && code === 'invalid_token') {
    return { kind: 'invalidToken', message: 'Your sign-in has expired. Sign in again.' };
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
    kind: binding.kind === 'space' ? 'space' : 'rig',
    lastSyncedAt: typeof raw?.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
    createdAt: typeof binding.createdAt === 'string' ? binding.createdAt : '',
    ...(typeof binding.updatedAt === 'string' ? { updatedAt: binding.updatedAt } : {}),
    relayHost,
  };
}

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs"): the
 * three states callers outside the RPC boundary actually need to branch
 * on — `main/rig/recent-rigs.ts`'s `recordRigOpened` (what to stamp on a
 * `rig_rigs` row), `main/rig/workspace.ts`'s `detect` (the foreign-account
 * check), and `main/rig/auth.ts`'s logout/login pause/resume hooks. Unlike
 * `me()`'s `Result<RigUser, RigAccountError>`, these callers don't care
 * which relay error kind occurred — only whether "signed out" is
 * confidently known (no token on disk at all, no network call needed) or
 * merely unresolvable right now (`'unknown'`: relay unreachable,
 * untrusted, or a malformed response) — a distinction `resolveContext`'s
 * `NOT_SIGNED_IN` vs. every other `RigAccountError` kind already draws.
 * Callers MUST treat `'unknown'` as "can't tell," never as `'signedOut'`:
 * a transient relay hiccup must never look like a sign-out and pause
 * someone's own rigs or block them from opening one.
 */
export type CurrentAccountId = { status: 'signedOut' } | { status: 'known'; id: string } | { status: 'unknown' };

/** See `CurrentAccountId`'s own doc comment for why this exists alongside `me()`. */
export async function getCurrentAccountId(): Promise<CurrentAccountId> {
  const result = await resolveSelfUserId();
  if (result.success) return { status: 'known', id: result.data };
  return result.error.kind === 'notSignedIn' ? { status: 'signedOut' } : { status: 'unknown' };
}

/**
 * The signed-in user's id, remembered per signed-in token (and relay): the
 * open path of a rig or space used to ask `GET /v1/me` three times in a row
 * (`detect`, the Room's connection info, the connector states). A different
 * token (sign-in, sign-out, another account) is a different key, so a stale
 * id is never served; `forgetSelfUserId` drops it outright on sign-in/out.
 * Only a successful answer is remembered — a relay hiccup is asked again.
 * Concurrent callers share one in-flight request.
 */
let selfUserId: { key: string; id: string } | null = null;
let selfUserIdLoad: { key: string; promise: Promise<Result<string, RigAccountError>> } | null = null;

function selfUserIdKey(ctx: Resolved): string {
  return `${ctx.url}\n${ctx.token}`;
}

export function forgetSelfUserId(): void {
  selfUserId = null;
  selfUserIdLoad = null;
}

/** The signed-in user's id when it's already known for the current token — never asks the relay (null otherwise). */
export async function peekSelfUserId(): Promise<string | null> {
  const ctx = await resolveContext();
  if (isError(ctx)) return null;
  return selfUserId?.key === selfUserIdKey(ctx) ? selfUserId.id : null;
}

export async function resolveSelfUserId(): Promise<Result<string, RigAccountError>> {
  const ctx = await resolveContext();
  if (isError(ctx)) return err(ctx);
  const key = selfUserIdKey(ctx);
  if (selfUserId?.key === key) return ok(selfUserId.id);
  if (selfUserIdLoad?.key === key) return selfUserIdLoad.promise;
  const load: { key: string; promise: Promise<Result<string, RigAccountError>> } = {
    key,
    promise: fetchSelfUserId(ctx).then((result) => {
      // Only if nothing forgot it (or asked for another account) meanwhile.
      if (selfUserIdLoad === load) {
        selfUserIdLoad = null;
        if (result.success) selfUserId = { key, id: result.data };
      }
      return result;
    }),
  };
  selfUserIdLoad = load;
  return load.promise;
}

async function fetchSelfUserId(ctx: Resolved): Promise<Result<string, RigAccountError>> {
  let response: Response;
  try {
    response = await relayGet(ctx, '/v1/me');
  } catch (error) {
    return err(transportError('load your account', error));
  }
  if (!response.ok) return err(await relayError(response, 'load your account'));
  try {
    const user = toUser(asRecord(await response.json())?.user);
    return user ? ok(user.id) : err<RigAccountError>({ kind: 'relay', message: 'Could not load your account.' });
  } catch (error) {
    return err(transportError('load your account', error));
  }
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
      // The app asks this at launch: the first rig or space opened after it needs no `/v1/me` of its own.
      selfUserId = { key: selfUserIdKey(ctx), id: user.id };
      return ok(user);
    } catch (error) {
      return err(transportError('load your account', error));
    }
  },

  /**
   * `GET /v1/me/bindings` — every workspace the signed-in user is a member of.
   * Home asks this whenever it shows, which is also when a rig.toml name
   * that changed outside the app (an agent's edit, a sync) gets pushed to
   * the relay — see `relay-name-sync.ts`. Loaded lazily: that module reaches
   * back into this one.
   */
  workspaces: async (): Promise<Result<RigWorkspaceBinding[], RigAccountError>> => {
    const result = await fetchWorkspaceBindings();
    if (result.success) {
      const bindings = result.data;
      // Home lists these again while the relay is out of reach (`local-cache-account.ts`).
      void import('./local-cache-account')
        .then(({ rememberWorkspaces }) => rememberWorkspaces(bindings))
        .catch(() => undefined);
      void import('./relay-name-sync-instance')
        .then(({ relayNameSync }) => relayNameSync.reconcile(bindings))
        .catch((error: unknown) => log.warn('rig: relay name sync failed', { error: String(error) }));
    }
    return result;
  },
});

/** `GET /v1/me/bindings`, parsed. The controller's `workspaces` without its side effects. */
export async function fetchWorkspaceBindings(): Promise<Result<RigWorkspaceBinding[], RigAccountError>> {
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
}
