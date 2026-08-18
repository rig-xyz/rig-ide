import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  RigInvite,
  RigInviteEmailOutcome,
  RigInviteList,
  RigInviteMinted,
  RigInviteRole,
  RigMember,
  RigMemberList,
  RigMyInvite,
  RigMyInviteAccepted,
  RigMyInviteList,
  RigShareError,
} from '@shared/rig/rig-share';
import { rigJoinPageUrl } from '@shared/urls';
import { resolveRelayUrl } from './account';
import { readSelfUserId, toMember } from './comments';
import { findBindingConfig } from './binding';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';

/**
 * Rig-level sharing (the file browser header's Share button): who is on this
 * rig, and — contract permitting — its outgoing invites.
 *
 * Own module, own `share` RPC key (the `share-links.ts` precedent): this is a
 * different relay resource plane than file comments or per-file share links,
 * and it's keyed by the bound workspace ROOT rather than a file path — there
 * is no file in play when the browser header asks "who's on this rig".
 * `resolveCommentTarget` can't resolve the root itself (its relPath would be
 * empty), so this module resolves the binding via `findBindingConfig(root)`
 * directly — the same walk `workspace.detect` trusts — and then reuses
 * `comments.ts`'s member coercion and self-identity read.
 *
 * Same trust-gated PAT pattern as `comments.ts`/`share-links.ts`: the PAT is
 * only ever attached by `relayFetch`, which is only callable with a
 * `Resolved`, which only `resolveContext` mints — behind `gateRelayTrust`.
 */

const REQUEST_TIMEOUT_MS = 10_000;

type Target = { bindingId: string; relayUrl: string };
type Resolved = { target: Target; token: string };

const NOT_BOUND: RigShareError = {
  kind: 'notBound',
  message: "This workspace isn't synced to a rig",
};
const UNAUTHENTICATED: RigShareError = {
  kind: 'unauthenticated',
  message: 'Not signed in to Rig Hub — run `rig login`',
};

/** Untrusted relays already warned about, keyed per (binding, host) — not per call. */
const warnedUntrustedRelays = new Set<string>();

function gateRelayTrust(target: Target): RigShareError | null {
  const trust = checkRelayTrust(target.relayUrl);
  if (trust.trusted) return null;
  const key = `${target.bindingId}|${trust.host}`;
  if (!warnedUntrustedRelays.has(key)) {
    warnedUntrustedRelays.add(key);
    log.warn('Rig share: refusing to send the relay token to an untrusted host', {
      bindingId: target.bindingId,
      host: trust.host,
    });
  }
  return {
    kind: 'untrustedRelay',
    host: trust.host,
    message: `This workspace points sharing at an unrecognized relay (${trust.host}) — sharing is disabled.`,
  };
}

async function resolveContext(root: string): Promise<Resolved | RigShareError> {
  const location = findBindingConfig(root);
  if (!location) return NOT_BOUND;
  const target: Target = {
    bindingId: location.config.bindingId,
    relayUrl: location.config.relayUrl,
  };
  const untrusted = gateRelayTrust(target);
  if (untrusted) return untrusted;
  const token = await readRelayToken();
  if (!token) return UNAUTHENTICATED;
  return { target, token };
}

function isError(value: Resolved | RigShareError): value is RigShareError {
  return 'kind' in value;
}

function bindingUrl({ target }: Resolved, suffix: string): string {
  const base = target.relayUrl.replace(/\/+$/, '');
  return `${base}/v1/me/bindings/${encodeURIComponent(target.bindingId)}${suffix}`;
}

type AccountResolved = { url: string; token: string };

/**
 * Account-plane context for the `/v1/me/invites` routes (the topbar bell):
 * no binding, no workspace root — the relay URL is the account-level one
 * (`RIG_RELAY_URL` or the default), the `join.ts`/`account.ts` precedent —
 * behind the same trust gate + PAT read as everything else here.
 */
async function resolveAccountContext(): Promise<AccountResolved | RigShareError> {
  const url = resolveRelayUrl();
  const trust = checkRelayTrust(url);
  if (!trust.trusted) {
    return {
      kind: 'untrustedRelay',
      host: trust.host,
      message: `RIG_RELAY_URL points at an unrecognized relay (${trust.host}) — refusing to send your sign-in token there.`,
    };
  }
  const token = await readRelayToken();
  if (!token) return UNAUTHENTICATED;
  return { url, token };
}

function isAccountError(value: AccountResolved | RigShareError): value is RigShareError {
  return 'kind' in value;
}

function accountFetch(
  ctx: AccountResolved,
  suffix: string,
  init: { method: 'GET' | 'POST'; body?: unknown }
): Promise<Response> {
  return fetch(`${ctx.url.replace(/\/+$/, '')}/v1/me${suffix}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Turns a non-2xx relay response into a message the UI can show in one line. */
async function relayError(response: Response, action: string): Promise<RigShareError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const raw = (body as Record<string, unknown>).error;
      if (typeof raw === 'string') code = raw;
    }
  } catch {
    // non-JSON body; the status alone has to do
  }
  if (response.status === 403) {
    return { kind: 'forbidden', message: `You don't have permission to ${action} on this rig.` };
  }
  // The relay answers 404 (not 403) for a binding you aren't a member of.
  if (response.status === 404) {
    return { kind: 'relay', status: 404, message: "This rig isn't available to you." };
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

async function relayFetch(
  ctx: Resolved,
  url: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }
): Promise<Response> {
  return fetch(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function transportError(action: string, error: unknown): RigShareError {
  log.warn('Rig share relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The caller's role, matched against the RAW members payload — not the
 * coerced `RigMember`s — because the id planes differ: a members row carries
 * both `userId` (the relay's own tap user id) and `clerkUserId` (the Clerk
 * id), while `GET /v1/me` (`readSelfUserId`) reports the CLERK id. Matching
 * the coerced `member.userId` (a tap id) against the Clerk id can never
 * succeed — the exact bug that hid the invite UI from an actual owner — so
 * this matches `clerkUserId` first, with a `userId` fallback in case a
 * future relay unifies the planes. Null when nothing matches: the popover
 * treats null as "can't tell", SHOWS the invite UI, and lets the relay's
 * own 403 answer — server enforcement is the truth; hiding management
 * affordances on a broken client-side guess is the worse failure.
 *
 * Exported pure for direct unit testing (`rig-share.test.ts`).
 */
export function deriveSelfRole(
  rawMembers: unknown[],
  selfClerkUserId: string | null
): string | null {
  if (!selfClerkUserId) return null;
  for (const value of rawMembers) {
    const raw = asRecord(value);
    if (!raw) continue;
    if (raw.clerkUserId === selfClerkUserId || raw.userId === selfClerkUserId) {
      return typeof raw.role === 'string' ? raw.role : null;
    }
  }
  return null;
}

/** Exported for direct unit testing, the `toShareLink`/`toMember` precedent. */
export function toInvite(value: unknown): RigInvite | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    emailConstraint: typeof raw.emailConstraint === 'string' ? raw.emailConstraint : null,
    role: typeof raw.role === 'string' ? raw.role : null,
    maxUses: typeof raw.maxUses === 'number' ? raw.maxUses : null,
    useCount: typeof raw.useCount === 'number' ? raw.useCount : 0,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    revokedAt: typeof raw.revokedAt === 'string' ? raw.revokedAt : null,
    label: typeof raw.label === 'string' ? raw.label : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

/** `email` on the mint response — absent (older relay) coerces to an honest "not sent". */
export function toEmailOutcome(value: unknown): RigInviteEmailOutcome {
  const raw = asRecord(value);
  return {
    sent: raw?.sent === true,
    to: typeof raw?.to === 'string' ? raw.to : null,
    reason: typeof raw?.reason === 'string' ? raw.reason : null,
  };
}

/** Coerces one entry of `GET /v1/me/invites`'s `invites[]`. Exported for direct unit testing. */
export function toMyInvite(value: unknown): RigMyInvite | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string') return null;
  const binding = asRecord(raw.binding);
  if (!binding || typeof binding.id !== 'string') return null;
  const inviter = asRecord(raw.inviter);
  return {
    id: raw.id,
    role: typeof raw.role === 'string' ? raw.role : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    binding: {
      id: binding.id,
      name: typeof binding.name === 'string' ? binding.name : null,
    },
    inviter: {
      name: typeof inviter?.name === 'string' ? inviter.name : null,
      email: typeof inviter?.email === 'string' ? inviter.email : null,
      avatarUrl: typeof inviter?.avatarUrl === 'string' ? inviter.avatarUrl : null,
    },
  };
}

// ── controller ───────────────────────────────────────────────────────────────

export const rigShareController = createRPCController({
  /**
   * Everyone on the rig this workspace is bound to, plus the caller's own
   * role (`GET /v1/me`'s Clerk id matched against the raw members rows —
   * the members payload itself doesn't say who "me" is; see
   * `deriveSelfRole` for the two id planes involved). `selfRole: null`
   * means the derivation failed, and the UI degrades by showing the invite
   * section anyway — the relay's own gating answers.
   */
  members: async ({ root }: { root: string }): Promise<Result<RigMemberList, RigShareError>> => {
    const ctx = await resolveContext(root);
    if (isError(ctx)) return err(ctx);
    const action = 'load members';

    let response: Response;
    try {
      response = await relayFetch(ctx, bindingUrl(ctx, '/members'), { method: 'GET' });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.members) ? data.members : [];
      const members = raw.map(toMember).filter((m): m is RigMember => m !== null);
      const selfClerkUserId = await readSelfUserId({ ...ctx.target, relPath: '' });
      const selfRole = deriveSelfRole(raw, selfClerkUserId);
      return ok({ members, selfRole });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /**
   * People to suggest in the invite form's autocomplete — every distinct
   * member across the OTHER rigs the caller already has (`bindingIds`,
   * supplied by the renderer from `rig.account.workspaces` — the same list
   * Home's rigs rail already fetches, so this rarely costs a fresh
   * `/v1/me/bindings` round trip on top). One `/members` read per binding,
   * in parallel, using the ACCOUNT-plane token — no per-workspace root
   * needed (unlike `members` above) because every id in `bindingIds` came
   * from `/v1/me/bindings` itself, i.e. already resolved against the
   * trusted account relay; there's no repo-controlled config in this path
   * to re-trust-check. Meant to be called ONCE per popover open, not per
   * keystroke — the renderer filters the returned list locally as the
   * caller types.
   *
   * Best-effort across bindings: one rig's `/members` failing (offline,
   * newly-revoked access, transient 5xx) drops just that rig's people from
   * the suggestion list rather than failing the whole popover.
   */
  collaborators: async ({
    bindingIds,
  }: {
    bindingIds: string[];
  }): Promise<Result<RigMember[], RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);

    const perBinding = await Promise.all(
      bindingIds.map(async (bindingId) => {
        try {
          const response = await accountFetch(ctx, `/bindings/${encodeURIComponent(bindingId)}/members`, {
            method: 'GET',
          });
          if (!response.ok) return [];
          const data = asRecord(await response.json());
          const raw = Array.isArray(data?.members) ? data.members : [];
          return raw.map(toMember).filter((m): m is RigMember => m !== null);
        } catch (error) {
          log.warn('Rig share: could not load members for a collaborator suggestion', {
            bindingId,
            error: String(error),
          });
          return [];
        }
      })
    );

    const byUserId = new Map<string, RigMember>();
    for (const member of perBinding.flat()) {
      if (!byUserId.has(member.userId)) byUserId.set(member.userId, member);
    }
    return ok([...byUserId.values()]);
  },

  /**
   * The rig's outgoing invites — `GET /v1/me/bindings/:bindingId/invites`,
   * owner-only on the relay (404 non-member, 403 `forbidden` non-owner; the
   * UI calls this when `selfRole` is `'owner'` OR null — the honest-
   * degradation path — and surfaces the 403 as-is). All statuses come back;
   * the renderer's `shapePendingInvites` filters to the pending ones.
   */
  listInvites: async ({ root }: { root: string }): Promise<Result<RigInviteList, RigShareError>> => {
    const ctx = await resolveContext(root);
    if (isError(ctx)) return err(ctx);
    const action = 'load invites';

    let response: Response;
    try {
      response = await relayFetch(ctx, bindingUrl(ctx, '/invites'), { method: 'GET' });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.invites) ? data.invites : [];
      return ok({ invites: raw.map(toInvite).filter((i): i is RigInvite => i !== null) });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /**
   * Mints a person invite — mirrors the hub `InviteModal`'s "person" mode
   * exactly (`POST /v1/me/bindings/:bindingId/invites`, owner-only):
   * full ops, a real role (editor/viewer only — the relay would accept
   * `owner` but the hub never offers it, and neither does this app), the
   * email constraint when one was typed. No `ttlSeconds` = never expires,
   * the hub's own default. The relay's `url` comes back for the copy flow —
   * see `RigInviteMinted`'s doc comment for why no email goes out here.
   */
  createInvite: async ({
    root,
    email,
    role,
  }: {
    root: string;
    email: string | null;
    role: RigInviteRole;
  }): Promise<Result<RigInviteMinted, RigShareError>> => {
    const ctx = await resolveContext(root);
    if (isError(ctx)) return err(ctx);
    const action = 'create the invite';
    const trimmed = email?.trim() ?? '';

    let response: Response;
    try {
      response = await relayFetch(ctx, bindingUrl(ctx, '/invites'), {
        method: 'POST',
        body: {
          ops: ['read', 'write', 'subscribe'],
          role,
          ...(trimmed ? { emailConstraint: trimmed } : {}),
        },
      });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      const invite = toInvite(data?.invite);
      // The CANONICAL link is the hub's friendly /join page built from the
      // response's `secret` — the same URL the relay's own invite email
      // links — never the relay's raw accept URL (which only survives as a
      // fallback for a relay old enough to not return `secret`).
      const secret = typeof data?.secret === 'string' ? data.secret : null;
      const rawUrl = typeof data?.url === 'string' ? data.url : null;
      const url = secret ? rigJoinPageUrl(secret) : rawUrl;
      if (!invite || !url) {
        return err<RigShareError>({ kind: 'relay', message: `Could not ${action}.` });
      }
      return ok({ invite, url, email: toEmailOutcome(data?.email) });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /**
   * Revokes an outgoing invite — `DELETE /v1/me/bindings/:bindingId/invites/:inviteId`
   * (owner-only, idempotent; also cascade-revokes any capability tokens the
   * invite's acceptances created, relay-side).
   */
  revokeInvite: async ({
    root,
    id,
  }: {
    root: string;
    id: string;
  }): Promise<Result<{ revoked: boolean }, RigShareError>> => {
    const ctx = await resolveContext(root);
    if (isError(ctx)) return err(ctx);
    const action = 'revoke the invite';

    let response: Response;
    try {
      response = await relayFetch(ctx, bindingUrl(ctx, `/invites/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      return ok({ revoked: data?.revoked === true });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  // ── invites addressed to ME (the topbar bell) — account plane ─────────────

  /**
   * Pending invites addressed to the signed-in caller — `GET /v1/me/invites`
   * (invitee plane, shipped 2026-08): active only, email-constrained to the
   * caller's verified email, declines excluded, newest first.
   */
  listMyInvites: async (): Promise<Result<RigMyInviteList, RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);
    const action = 'load your invites';

    let response: Response;
    try {
      response = await accountFetch(ctx, '/invites', { method: 'GET' });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.invites) ? data.invites : [];
      return ok({ invites: raw.map(toMyInvite).filter((i): i is RigMyInvite => i !== null) });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /**
   * Accepts an invite BY ID — `POST /v1/me/invites/:inviteId/accept`
   * (authorization is the verified-email match; no plaintext secret exists
   * client-side on this plane). The relay answers the standard
   * `AcceptInviteResponse` — bindingId, device, a fresh `tap_cap_` device
   * token, member row — in the same transaction as the secret-based accept.
   *
   * DELIBERATE REDUCTION: the device token is dropped here, not returned.
   * Local materialization is tapd's job (`tapd join` = accept-by-secret +
   * write `.rig/tap-binding.local.json` + seed `state.local.db`), and no
   * CLI verb consumes an already-minted device token today — so acceptance
   * ends, honestly, at server-side membership: the rig appears in Home's
   * shared list (`rig.account.workspaces`). See the round report for the
   * proposed `rig join --with-token` / member self-device contract that
   * would let this open the rig locally.
   */
  acceptMyInvite: async ({
    id,
  }: {
    id: string;
  }): Promise<Result<RigMyInviteAccepted, RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);
    const action = 'accept the invite';

    let response: Response;
    try {
      response = await accountFetch(ctx, `/invites/${encodeURIComponent(id)}/accept`, {
        method: 'POST',
        body: {},
      });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) {
      // 400 invite_invalid = the invite went stale between listing and
      // accepting (revoked/expired/exhausted meanwhile).
      if (response.status === 400) {
        return err<RigShareError>({
          kind: 'relay',
          status: 400,
          message: 'This invite is no longer valid — ask for a new one.',
        });
      }
      if (response.status === 404) {
        return err<RigShareError>({
          kind: 'relay',
          status: 404,
          message: 'This invite is no longer available.',
        });
      }
      return err(await relayError(response, action));
    }

    try {
      const data = asRecord(await response.json());
      const bindingId = typeof data?.bindingId === 'string' ? data.bindingId : null;
      if (!bindingId) {
        return err<RigShareError>({ kind: 'relay', message: `Could not ${action}.` });
      }
      return ok({ bindingId, becameMember: asRecord(data?.member) !== null });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /**
   * Declines an invite — `POST /v1/me/invites/:inviteId/decline`, a
   * per-user hide (idempotent; the invite itself stays valid for its link).
   */
  declineMyInvite: async ({
    id,
  }: {
    id: string;
  }): Promise<Result<{ declined: boolean }, RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);
    const action = 'decline the invite';

    let response: Response;
    try {
      response = await accountFetch(ctx, `/invites/${encodeURIComponent(id)}/decline`, {
        method: 'POST',
        body: {},
      });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      return ok({ declined: data?.declined === true });
    } catch (error) {
      return err(transportError(action, error));
    }
  },
});
