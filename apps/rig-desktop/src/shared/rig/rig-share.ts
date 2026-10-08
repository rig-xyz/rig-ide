/**
 * Rig-level sharing contract (the file browser header's Share button), shared
 * by the main-process relay client (`main/rig/rig-share.ts`) and the
 * renderer's share popover (`renderer/features/rig-share/`).
 *
 * Distinct from `share-links.ts` (public capability links to ONE file): this
 * surface is about the people on the rig — the binding's members and its
 * outgoing invites. Keyed by the bound workspace ROOT rather than a file's
 * absolute path, since membership is a rig-level fact with no file involved.
 */

import type { RigCommentMember } from './comments';

/**
 * Same failure vocabulary as `share-links.ts`'s, minus the file-specific
 * `notFound`, plus `'bindingDeleted'` (delete-a-rig round): every
 * binding-scoped relay route answers 410 `{error: 'binding_deleted', ...}`
 * once the binding's owner has deleted it — parsed in exactly one place,
 * `main/rig/rig-share.ts`'s `relayError`, so every call in this module
 * (`members`, `listInvites`, `createInvite`, `revokeInvite`) surfaces it the
 * same way rather than reading as a generic `'relay'` failure.
 */
export type RigShareError = {
  kind: 'notBound' | 'unauthenticated' | 'untrustedRelay' | 'forbidden' | 'relay' | 'bindingDeleted';
  message: string;
  /** HTTP status, when the relay answered. */
  status?: number;
  /** The offending relay host, for `untrustedRelay`. */
  host?: string;
  /** Only set when `kind === 'bindingDeleted'`. */
  deletedAt?: string;
  /** Only set when `kind === 'bindingDeleted'`. */
  deletedBy?: { name: string | null; email: string | null };
};

/** Re-exported so the share popover doesn't reach into the comments contract for a person. */
export type RigMember = RigCommentMember;

export type RigMemberList = {
  members: RigMember[];
  /** The caller's own role on this binding, when the relay reports it — gates invite UI. */
  selfRole: string | null;
  /** The caller's own member `userId` (tap id), when it could be matched; hides actions on your own row. */
  selfUserId?: string | null;
};

/**
 * One of Your people (`GET /v1/me/people`): someone you share or shared a
 * space with, best first. Never carries an email; an invite reaches them by
 * `userId` (`targetUserId`). `viaOrg` is someone known only through your
 * organization.
 */
export type RigPerson = {
  userId: string;
  clerkUserId: string | null;
  name: string | null;
  avatarUrl: string | null;
  sharedSpaces: { bindingId: string; name: string | null }[];
  lastSharedAt: string | null;
  viaOrg: boolean;
};

/**
 * `supported: false` when the relay is older than `/v1/me/people` (it
 * answered 404): the invite field falls back to the members fan-out
 * (`collaborators`) and invites by email only.
 */
export type RigPeopleList = {
  supported: boolean;
  people: RigPerson[];
};

/**
 * The roles the invite form offers — mirrors the hub's `InviteModal`, which
 * only ever offers editor/viewer (`owner` is accepted by the relay but
 * deliberately never surfaced there, and not here either).
 */
export type RigInviteRole = 'editor' | 'viewer';

/**
 * One outgoing invite, as `GET /v1/me/bindings/:bindingId/invites` reports it
 * (tap relay `routes/account.ts`, owner-only). The relay returns ALL invites
 * — active, revoked, expired, exhausted — newest first; callers filter (the
 * renderer's `invite-state.ts` does). `role: null` is a pure-capability link
 * invite (no member row on acceptance); `emailConstraint` is who it's locked
 * to, when it is.
 */
export type RigInvite = {
  id: string;
  emailConstraint: string | null;
  role: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  label: string | null;
  createdAt: string;
  /** A person invite: who it's aimed at (tap user id), with their name and photo. Null for email and link invites. */
  targetUserId?: string | null;
  targetName?: string | null;
  targetAvatarUrl?: string | null;
};

export type RigInviteList = {
  invites: RigInvite[];
};

/**
 * What actually happened to the invite email at mint time, verbatim from the
 * relay (`email` on the mint response): `sent: true` means the relay's own
 * best-effort delivery accepted it for `to`; `sent: false` carries a
 * `reason` (`no_email` when the invite had no constraint, or a delivery
 * failure). Never fails the mint — the link always works regardless.
 */
export type RigInviteEmailOutcome = {
  sent: boolean;
  to: string | null;
  reason: string | null;
};

/**
 * `POST /v1/me/bindings/:bindingId/invites`'s answer: the invite row, the
 * CANONICAL join link, and the email outcome. `url` is the hub's friendly
 * `https://userig.xyz/join/<secret>` page (built main-side from the mint
 * response's `secret` — the same URL the relay's own invite email links),
 * NOT the relay's raw accept URL. This is the one moment the secret-bearing
 * link exists client-side; the invites list never carries it again.
 */
export type RigInviteMinted = {
  invite: RigInvite;
  url: string;
  email: RigInviteEmailOutcome;
};

// ── invites addressed to ME (the topbar bell) ───────────────────────────────

/**
 * One pending invite addressed to the signed-in caller, as
 * `GET /v1/me/invites` reports it (account plane, not binding-keyed):
 * active only (non-revoked/expired/exhausted), email-constrained to the
 * caller's verified email, minus any they've declined, newest first —
 * enriched relay-side with the rig's name and the inviter's profile.
 */
export type RigMyInvite = {
  id: string;
  /** The member role acceptance grants (invitee-plane invites are always email-constrained person invites, but null is tolerated). */
  role: string | null;
  createdAt: string;
  expiresAt: string | null;
  binding: { id: string; name: string | null };
  inviter: { name: string | null; email: string | null; avatarUrl: string | null };
};

export type RigMyInviteList = {
  invites: RigMyInvite[];
};

/**
 * `POST /v1/me/invites/:inviteId/accept`'s answer, REDUCED: the relay's full
 * `AcceptInviteResponse` (same transaction/shape as the secret-based accept)
 * also mints a device + `tap_cap_` token, but that secret stays in the main
 * process and is deliberately never forwarded to the renderer — nothing
 * desktop-side can materialize a local workspace from a bare device token
 * today (see the accept method's doc comment in `main/rig/rig-share.ts`),
 * so shipping it across the IPC boundary would be a secret with no purpose.
 */
export type RigMyInviteAccepted = {
  bindingId: string;
  becameMember: boolean;
};

/**
 * Home's "Join with a link": `POST /v1/invites/:secret/accept` (the
 * secret-based accept), REDUCED like `RigMyInviteAccepted` — the device
 * token never leaves the main process. `spaceName` comes from the invite's
 * public preview (`GET /v1/invites/:secret`); `null` when that didn't say.
 * Already being a member is a success (`becameMember: false`).
 */
export type RigInviteLinkJoined = {
  bindingId: string;
  spaceName: string | null;
  becameMember: boolean;
};

/**
 * `GET /v1/invites/:secret`'s public preview, REDUCED to what a confirm
 * needs to name: the space and who shared it (`inviterName` falls back to
 * the inviter's email). Either is `null` when the relay didn't say, or
 * didn't answer (a rate limit, a hiccup): the accept is authoritative.
 */
export type RigInvitePreview = {
  spaceName: string | null;
  inviterName: string | null;
  /** An email invite's address, masked by the relay (`h•••@gmail.com`); null for a link anyone can use. */
  emailHint: string | null;
};

export type RigInviteLinkError = {
  kind:
    /** Not a `userig.xyz/join/<secret>` link. */
    | 'invalidLink'
    /** No usable sign-in on this device — the caller falls back to the browser. */
    | 'notSignedIn'
    | 'expired'
    | 'revoked'
    /** Used up (a single-use link someone already accepted). */
    | 'used'
    /** No such invite on the relay. */
    | 'notFound'
    /** Addressed to a different email than the signed-in account's. */
    | 'wrongAccount'
    /** The relay couldn't be reached. */
    | 'network'
    | 'relay';
  message: string;
  status?: number;
  /** `wrongAccount`: the address the invite is for, masked by the relay. */
  invitedHint?: string;
  /** `wrongAccount`: the address you're signed in with. */
  signedInAs?: string;
};
