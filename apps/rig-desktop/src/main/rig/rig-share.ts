import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  RigInvite,
  RigInviteEmailOutcome,
  RigInviteLinkError,
  RigInviteLinkJoined,
  RigInviteList,
  RigInviteMinted,
  RigInvitePreview,
  RigInviteRole,
  RigMember,
  RigMemberList,
  RigMyInvite,
  RigMyInviteAccepted,
  RigMyInviteList,
  RigPeopleList,
  RigPerson,
  RigShareError,
} from '@shared/rig/rig-share';
import { extractInviteSecret } from '@shared/rig/invite-link';
import { rigJoinPageUrl } from '@shared/urls';
import { resolveRelayUrl } from './account';
import { notAMemberMessage, readSelfUserId, toMember } from './comments';
import { findBindingConfig } from './binding';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';
import { fetchRelay } from './relay-request';
import { parseBindingKind } from '@shared/rig/invite-label';

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
 * behind the same trust gate + PAT read as everything else here. Exported
 * for `main/rig/delete-rig.ts` — the account-plane `DELETE`/`leave` calls
 * need this same trust-gated context, not a per-workspace one (there's no
 * workspace root for a relay-only row).
 */
export async function resolveAccountContext(): Promise<AccountResolved | RigShareError> {
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

/** Exported for `main/rig/delete-rig.ts` — see `resolveAccountContext`'s own doc comment. */
export function isAccountError(value: AccountResolved | RigShareError): value is RigShareError {
  return 'kind' in value;
}

export type { AccountResolved };

/** Exported for `main/rig/delete-rig.ts`'s `DELETE`/`leave` calls — see `resolveAccountContext`'s own doc comment. */
export function accountFetch(
  ctx: AccountResolved,
  suffix: string,
  init: { method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; body?: unknown }
): Promise<Response> {
  return fetchRelay(`${ctx.url.replace(/\/+$/, '')}/v1/me${suffix}`, {
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

/**
 * Delete-a-rig round: `{deletedAt, deletedBy}` out of a 410's JSON body —
 * `null` when the body isn't actually the `binding_deleted` shape (an older
 * relay's plain 410, or a malformed body), in which case the caller falls
 * through to the generic `'relay'` handling below. Exported for direct unit
 * testing, the `toInvite`/`toMember` precedent.
 */
export function parseBindingDeletedBody(
  body: unknown
): { deletedAt: string; deletedBy: { name: string | null; email: string | null } } | null {
  const raw = asRecord(body);
  if (!raw || raw.error !== 'binding_deleted') return null;
  const deletedBy = asRecord(raw.deletedBy);
  return {
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : '',
    deletedBy: {
      name: typeof deletedBy?.name === 'string' ? deletedBy.name : null,
      email: typeof deletedBy?.email === 'string' ? deletedBy.email : null,
    },
  };
}

/**
 * Turns a non-2xx relay response into a message the UI can show in one
 * line. Delete-a-rig round: this is the ONE place a 410 is parsed for every
 * binding-scoped call in this module (`members`, `listInvites`,
 * `createInvite`, `revokeInvite`) — each surfaces `kind: 'bindingDeleted'`
 * the same way rather than the generic `'relay'` fallback, so the renderer
 * can recognize "this rig was deleted" regardless of which call noticed it
 * first.
 */
/**
 * `target` is omitted by the account-plane call sites (`listMyInvites`,
 * `acceptMyInvite`, `declineMyInvite` — no workspace binding is involved),
 * which keeps their 404 message exactly as before; the workspace-bound call
 * sites (`members`, `listInvites`, `createInvite`, `revokeInvite`) pass
 * `ctx.target` so the same-account bug fix in `comments.ts`'s
 * `notAMemberMessage` applies here too.
 */
async function relayError(response: Response, action: string, target?: Target): Promise<RigShareError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // non-JSON body; the status alone has to do
  }
  if (response.status === 410) {
    const deleted = parseBindingDeletedBody(body);
    if (deleted) {
      // A deleted rig's cached Room and comment threads go too (lazy: the cache module opens the app DB).
      if (target) {
        void import('./local-cache-account')
          .then((m) => m.forgetLocalCaches(target.bindingId))
          .catch(() => undefined);
      }
      return {
        kind: 'bindingDeleted',
        message: 'This rig was deleted.',
        status: 410,
        deletedAt: deleted.deletedAt,
        deletedBy: deleted.deletedBy,
      };
    }
  }
  const code = typeof asRecord(body)?.error === 'string' ? (asRecord(body)?.error as string) : null;
  if (response.status === 403 && code === 'not_your_person') {
    return { kind: 'forbidden', status: 403, message: 'You can only invite people you share a space with by name. Use their email instead.' };
  }
  if (response.status === 403) {
    return { kind: 'forbidden', message: `You don't have permission to ${action} on this rig.` };
  }
  // The relay answers 404 (not 403) for a binding you aren't a member of.
  if (response.status === 404) {
    const message = target
      ? await notAMemberMessage({ ...target, relPath: '' }, "This rig isn't available to you.")
      : "This rig isn't available to you.";
    return { kind: 'relay', status: 404, message };
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
  init: { method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; body?: unknown }
): Promise<Response> {
  return fetchRelay(url, {
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
  return { kind: 'relay', message: `Could not ${action}. Rig can't reach the server right now.` };
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
    targetUserId: typeof raw.targetUserId === 'string' ? raw.targetUserId : null,
    targetName: typeof raw.targetName === 'string' ? raw.targetName : null,
    targetAvatarUrl: typeof raw.targetImageUrl === 'string' ? raw.targetImageUrl : null,
  };
}

/** Coerces one entry of `GET /v1/me/people`'s `people[]`. Exported for direct unit testing. */
export function toPerson(value: unknown): RigPerson | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.userId !== 'string') return null;
  const spaces = Array.isArray(raw.sharedSpaces) ? raw.sharedSpaces : [];
  return {
    userId: raw.userId,
    clerkUserId: typeof raw.clerkUserId === 'string' ? raw.clerkUserId : null,
    name: typeof raw.name === 'string' && raw.name ? raw.name : null,
    avatarUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
    sharedSpaces: spaces.flatMap((entry) => {
      const space = asRecord(entry);
      if (!space || typeof space.bindingId !== 'string') return [];
      return [{ bindingId: space.bindingId, name: typeof space.name === 'string' ? space.name : null }];
    }),
    lastSharedAt: typeof raw.lastSharedAt === 'string' ? raw.lastSharedAt : null,
    viaOrg: raw.viaOrg === true,
  };
}

/** The caller's own member row's tap `userId`, by the same Clerk-id match as `deriveSelfRole`. */
export function deriveSelfUserId(rawMembers: unknown[], selfClerkUserId: string | null): string | null {
  if (!selfClerkUserId) return null;
  for (const value of rawMembers) {
    const raw = asRecord(value);
    if (raw && (raw.clerkUserId === selfClerkUserId || raw.userId === selfClerkUserId)) {
      return typeof raw.userId === 'string' ? raw.userId : null;
    }
  }
  return null;
}

// ── Your people cache ────────────────────────────────────────────────────────

/**
 * `GET /v1/me/people` changes only when you invite, accept or remove
 * someone, and every invite field open reads it: a short cache here, keyed
 * by the sign-in token so a different account never sees the last one's
 * list. Cleared after every call that can change it.
 */
const PEOPLE_TTL_MS = 60_000;
let peopleCache: { token: string; at: number; value: RigPeopleList } | null = null;

export function forgetPeopleCache(): void {
  peopleCache = null;
}

/** The relay's own JSON `error` code, when the body has one. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = asRecord(await response.clone().json());
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Mints one invite on `url` (a binding's `/invites`) for a person, an email,
 * or anyone with the link. A person invite that comes back without its
 * target means a relay too old to know `targetUserId`: it minted an open
 * link instead, so that link is revoked at once and the call fails.
 */
async function mintInvite(
  send: (path: string, init: { method: 'POST' | 'DELETE'; body?: unknown }) => Promise<Response>,
  args: { email: string | null; targetUserId: string | null; role: RigInviteRole },
  action: string,
  target?: Target
): Promise<Result<RigInviteMinted, RigShareError>> {
  const email = args.email?.trim() ?? '';
  let response: Response;
  try {
    response = await send('/invites', {
      method: 'POST',
      body: {
        ops: ['read', 'write', 'subscribe'],
        role: args.role,
        ...(args.targetUserId ? { targetUserId: args.targetUserId } : email ? { emailConstraint: email } : {}),
      },
    });
  } catch (error) {
    return err(transportError(action, error));
  }
  if (!response.ok) return err(await relayError(response, action, target));

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
    if (args.targetUserId && invite.targetUserId !== args.targetUserId) {
      await send(`/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' }).catch(() => undefined);
      return err<RigShareError>({
        kind: 'relay',
        message: "This Rig server can't invite people by name yet. Use their email instead.",
      });
    }
    forgetPeopleCache();
    telemetryService.capture('invite_sent', {});
    return ok({ invite, url, expiresAt: invite.expiresAt, email: toEmailOutcome(data?.email) });
  } catch (error) {
    return err(transportError(action, error));
  }
}

/** One owner-only member call (role, remove, hand over), its errors in plain words. */
async function memberCall(
  root: string,
  suffix: string,
  init: { method: 'PATCH' | 'DELETE' | 'POST'; body?: unknown },
  action: string
): Promise<Result<{ done: true }, RigShareError>> {
  const ctx = await resolveContext(root);
  if (isError(ctx)) return err(ctx);
  let response: Response;
  try {
    response = await relayFetch(ctx, bindingUrl(ctx, suffix), init);
  } catch (error) {
    return err(transportError(action, error));
  }
  if (response.ok) {
    forgetPeopleCache();
    return ok({ done: true });
  }
  const code = await errorCode(response);
  // An unknown route on an older relay answers a plain, non-JSON 404.
  if (response.status === 404 && code === null) {
    return err<RigShareError>({ kind: 'relay', status: 404, message: `This Rig server can't ${action} yet.` });
  }
  if (code === 'not_a_member') {
    return err<RigShareError>({ kind: 'relay', status: 404, message: "They're no longer in this space." });
  }
  return err(await relayError(response, action, ctx.target));
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
      kind: parseBindingKind(binding.kind),
    },
    inviter: {
      name: typeof inviter?.name === 'string' ? inviter.name : null,
      email: typeof inviter?.email === 'string' ? inviter.email : null,
      avatarUrl: typeof inviter?.avatarUrl === 'string' ? inviter.avatarUrl : null,
    },
  };
}

// ── join by link ─────────────────────────────────────────────────────────────

const INVITE_LINK_NOT_FOUND: RigInviteLinkError = {
  kind: 'notFound',
  status: 404,
  message: "This invite link doesn't exist — check it, or ask for a new one.",
};

/** The relay's `invite_invalid` reasons (and the preview's `status`) → this plane's typed kinds. */
export function inviteLinkInvalid(
  reason: unknown,
  emails: { invitedHint?: unknown; signedInAs?: unknown } = {}
): RigInviteLinkError {
  switch (reason) {
    case 'expired':
      return { kind: 'expired', status: 400, message: 'This invite link has expired — ask for a new one.' };
    case 'revoked':
      return { kind: 'revoked', status: 400, message: 'This invite link was revoked — ask for a new one.' };
    case 'exhausted':
      return { kind: 'used', status: 400, message: 'This invite link has already been used — ask for a new one.' };
    case 'email_mismatch': {
      const invitedHint = typeof emails.invitedHint === 'string' && emails.invitedHint ? emails.invitedHint : undefined;
      const signedInAs = typeof emails.signedInAs === 'string' && emails.signedInAs ? emails.signedInAs : undefined;
      return {
        kind: 'wrongAccount',
        status: 400,
        message:
          invitedHint && signedInAs
            ? `This invite is for ${invitedHint}. You're signed in as ${signedInAs}.`
            : invitedHint
              ? `This invite is for ${invitedHint}, not the account you're signed in with.`
              : "This invite is for a different email than the one you're signed in with.",
        ...(invitedHint ? { invitedHint } : {}),
        ...(signedInAs ? { signedInAs } : {}),
      };
    }
    default:
      return { kind: 'relay', status: 400, message: 'This invite link is no longer valid — ask for a new one.' };
  }
}

/** The accept route's other refusals, in plain words instead of the relay's code. */
const INVITE_ACCEPT_ERRORS: Record<string, Pick<RigInviteLinkError, 'kind' | 'message'>> = {
  invite_for_someone_else: {
    kind: 'wrongAccount',
    message: 'This invite was sent to someone else. Ask them to invite your account.',
  },
  account_deletion_pending: {
    kind: 'relay',
    message: 'Your account is set to be deleted. Sign in again to keep it, then open the invite again.',
  },
  clerk_unavailable: {
    kind: 'network',
    message: 'Rig couldn’t check your account just now. Try again in a minute.',
  },
};

/** Like `transportError`, but the logged error text is scrubbed of the secret (it rides in the request URL). */
function inviteLinkTransportError(action: string, error: unknown, secret: string): RigInviteLinkError {
  const scrubbed = String(error).split(secret).join('…').split(encodeURIComponent(secret)).join('…');
  log.warn('Rig share: invite link request failed', { action, error: scrubbed });
  return { kind: 'network', message: `Could not ${action}. Rig can't reach the server right now.` };
}

const EMPTY_INVITE_PREVIEW: RigInvitePreview = { spaceName: null, inviterName: null, emailHint: null, kind: null };

/**
 * `GET /v1/invites/:secret` — the relay's public preview (no token: the
 * secret itself authorizes it). A 404 or a revoked/expired status is final;
 * any other non-2xx (a rate limit, a relay hiccup) yields an empty preview,
 * since the accept is authoritative anyway.
 */
async function fetchInvitePreview(
  relayUrl: string,
  secret: string,
  action: string
): Promise<Result<RigInvitePreview, RigInviteLinkError>> {
  try {
    const response = await fetchRelay(`${relayUrl.replace(/\/+$/, '')}/v1/invites/${encodeURIComponent(secret)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return err(INVITE_LINK_NOT_FOUND);
    if (!response.ok) return ok(EMPTY_INVITE_PREVIEW);
    const data = asRecord(await response.json());
    if (data?.status === 'revoked' || data?.status === 'expired') return err(inviteLinkInvalid(data.status));
    const binding = asRecord(data?.binding);
    const name = binding?.name;
    const inviter = asRecord(data?.inviter);
    const inviterName = [inviter?.name, inviter?.email].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    return ok({
      spaceName: typeof name === 'string' && name ? name : null,
      inviterName: inviterName ?? null,
      emailHint: typeof data?.emailHint === 'string' && data.emailHint ? data.emailHint : null,
      kind: parseBindingKind(binding?.kind),
    });
  } catch (error) {
    return err(inviteLinkTransportError(action, error, secret));
  }
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
    if (!response.ok) return err(await relayError(response, action, ctx.target));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.members) ? data.members : [];
      const members = raw.map(toMember).filter((m): m is RigMember => m !== null);
      const selfClerkUserId = await readSelfUserId({ ...ctx.target, relPath: '' });
      const selfRole = deriveSelfRole(raw, selfClerkUserId);
      const selfUserId = deriveSelfUserId(raw, selfClerkUserId);
      return ok({ members, selfRole, selfUserId });
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
    if (!response.ok) return err(await relayError(response, action, ctx.target));

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
   * email constraint when one was typed. No `ttlSeconds`: the relay's
   * default applies (a week, `security-config.ts`), and the answer's
   * `expiresAt` says when. The relay's `url` comes back for the copy flow —
   * see `RigInviteMinted`'s doc comment for why no email goes out here.
   */
  createInvite: async ({
    root,
    email,
    role,
    targetUserId = null,
  }: {
    root: string;
    /** Locks the invite to this email; ignored when `targetUserId` is set. Neither: an open link. */
    email: string | null;
    role: RigInviteRole;
    /** One of Your people (tap user id): the invite reaches their bell, no email needed. */
    targetUserId?: string | null;
  }): Promise<Result<RigInviteMinted, RigShareError>> => {
    const ctx = await resolveContext(root);
    if (isError(ctx)) return err(ctx);
    return mintInvite(
      (suffix, init) => relayFetch(ctx, bindingUrl(ctx, suffix), init),
      { email, targetUserId, role },
      'create the invite',
      ctx.target
    );
  },

  /**
   * The person card's "Invite to a space": a person invite into one of
   * your spaces by binding id (from `/v1/me/bindings`, so already on the
   * trusted account relay), with no workspace root involved.
   */
  inviteToSpace: async ({
    bindingId,
    targetUserId,
    role,
  }: {
    bindingId: string;
    targetUserId: string;
    role: RigInviteRole;
  }): Promise<Result<RigInviteMinted, RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);
    return mintInvite(
      (suffix, init) => accountFetch(ctx, `/bindings/${encodeURIComponent(bindingId)}${suffix}`, init),
      { email: null, targetUserId, role },
      'create the invite'
    );
  },

  /**
   * Your people (`GET /v1/me/people`), cached for a minute (see
   * `peopleCache`). An older relay answers 404: `supported: false`, and
   * the renderer falls back to `collaborators`.
   */
  people: async (): Promise<Result<RigPeopleList, RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);
    if (peopleCache && peopleCache.token === ctx.token && Date.now() - peopleCache.at < PEOPLE_TTL_MS) {
      return ok(peopleCache.value);
    }
    const action = 'load your people';
    let response: Response;
    try {
      response = await accountFetch(ctx, '/people', { method: 'GET' });
    } catch (error) {
      return err(transportError(action, error));
    }
    let value: RigPeopleList;
    if (response.status === 404) {
      value = { supported: false, people: [] };
    } else if (!response.ok) {
      return err(await relayError(response, action));
    } else {
      try {
        const data = asRecord(await response.json());
        const raw = Array.isArray(data?.people) ? data.people : [];
        value = { supported: true, people: raw.map(toPerson).filter((p): p is RigPerson => p !== null) };
      } catch (error) {
        return err(transportError(action, error));
      }
    }
    peopleCache = { token: ctx.token, at: Date.now(), value };
    return ok(value);
  },

  /** "Remove from your people": `DELETE /v1/me/people/:userId`, a hide on your own list only. */
  forgetPerson: async ({ userId }: { userId: string }): Promise<Result<{ removed: true }, RigShareError>> => {
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) return err(ctx);
    const action = 'remove them from your people';
    let response: Response;
    try {
      response = await accountFetch(ctx, `/people/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    } catch (error) {
      return err(transportError(action, error));
    }
    forgetPeopleCache();
    if (!response.ok) return err(await relayError(response, action));
    return ok({ removed: true });
  },

  /** Owner only: `PATCH /v1/me/bindings/:id/members/:userId {role}`. */
  setMemberRole: ({ root, userId, role }: { root: string; userId: string; role: RigInviteRole }) =>
    memberCall(root, `/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } }, 'change their role'),

  /** Owner only: `DELETE /v1/me/bindings/:id/members/:userId` (the relay revokes their tokens too). */
  removeMember: ({ root, userId }: { root: string; userId: string }) =>
    memberCall(root, `/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }, 'remove them'),

  /** Owner only: `POST /v1/me/bindings/:id/owner {userId}`; the previous owner becomes an editor. */
  makeOwner: ({ root, userId }: { root: string; userId: string }) =>
    memberCall(root, '/owner', { method: 'POST', body: { userId } }, 'hand over ownership'),

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
    if (!response.ok) return err(await relayError(response, action, ctx.target));

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
      forgetPeopleCache();
      telemetryService.capture('invite_accepted', {});
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

  /**
   * Home's "Join with a link": accepts a pasted `userig.xyz/join/<secret>`
   * link against the signed-in account's relay — `GET /v1/invites/:secret`
   * (public preview: the space's name, and an early no for a revoked or
   * expired link), then `POST /v1/invites/:secret/accept` (user auth). The
   * device token the accept mints is dropped, same deliberate reduction as
   * `acceptMyInvite` above; the renderer then runs `join.attach` like the
   * emailed-invite flow. Accepting a link to a space you're already in
   * succeeds (the relay answers 201 with `member: null`). The secret is
   * never logged, and never part of an error message.
   */
  /**
   * The invite's public preview (`GET /v1/invites/:secret`) for the
   * `rig://join/<secret>` confirm dialog: which space, and who shared it.
   * Needs no sign-in (the secret authorizes it), so it's asked of the
   * account relay without reading the token at all; the same trust gate
   * still applies to where the secret is sent.
   */
  previewInviteLink: async ({ link }: { link: string }): Promise<Result<RigInvitePreview, RigInviteLinkError>> => {
    const secret = extractInviteSecret(link);
    if (!secret) {
      return err<RigInviteLinkError>({ kind: 'invalidLink', message: "That doesn't look like a rig invite link." });
    }
    const url = resolveRelayUrl();
    const trust = checkRelayTrust(url);
    if (!trust.trusted) {
      return err<RigInviteLinkError>({
        kind: 'relay',
        message: `RIG_RELAY_URL points at an unrecognized relay (${trust.host}) — refusing to send the invite there.`,
      });
    }
    return fetchInvitePreview(url, secret, 'load this invite');
  },

  acceptInviteLink: async ({
    link,
  }: {
    link: string;
  }): Promise<Result<RigInviteLinkJoined, RigInviteLinkError>> => {
    const secret = extractInviteSecret(link);
    if (!secret) {
      return err<RigInviteLinkError>({ kind: 'invalidLink', message: "That doesn't look like a rig invite link." });
    }
    const ctx = await resolveAccountContext();
    if (isAccountError(ctx)) {
      return err<RigInviteLinkError>(
        ctx.kind === 'unauthenticated'
          ? { kind: 'notSignedIn', message: ctx.message }
          : { kind: 'relay', message: ctx.message }
      );
    }
    const action = 'join with this link';
    const inviteUrl = `${ctx.url.replace(/\/+$/, '')}/v1/invites/${encodeURIComponent(secret)}`;

    const preview = await fetchInvitePreview(ctx.url, secret, action);
    if (!preview.success) return err(preview.error);
    const { spaceName, kind } = preview.data;

    let response: Response;
    try {
      response = await fetchRelay(`${inviteUrl}/accept`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ctx.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return err(inviteLinkTransportError(action, error, secret));
    }
    if (!response.ok) {
      const body = asRecord(await response.json().catch(() => null));
      if (response.status === 401) {
        return err<RigInviteLinkError>({ kind: 'notSignedIn', status: 401, message: 'Your sign-in has expired.' });
      }
      if (response.status === 404) return err(INVITE_LINK_NOT_FOUND);
      if (response.status === 400 && body?.error === 'invite_invalid') return err(inviteLinkInvalid(body.reason, body));
      const code = typeof body?.error === 'string' ? body.error : null;
      const plain = code ? INVITE_ACCEPT_ERRORS[code] : undefined;
      if (plain) return err<RigInviteLinkError>({ ...plain, status: response.status });
      return err<RigInviteLinkError>({
        kind: 'relay',
        status: response.status,
        message: code ? `Could not ${action} (relay: ${code}).` : `Could not ${action} (relay ${response.status}).`,
      });
    }

    try {
      const data = asRecord(await response.json());
      const bindingId = typeof data?.bindingId === 'string' ? data.bindingId : null;
      if (!bindingId) return err<RigInviteLinkError>({ kind: 'relay', message: `Could not ${action}.` });
      forgetPeopleCache();
      telemetryService.capture('invite_accepted', {});
      return ok({ bindingId, spaceName, kind, becameMember: asRecord(data?.member) !== null });
    } catch (error) {
      return err(inviteLinkTransportError(action, error, secret));
    }
  },
});
