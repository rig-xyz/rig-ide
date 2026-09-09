/**
 * Pure derivations for the topbar invites bell (invites addressed to ME —
 * `rig.share.listMyInvites`, the relay's invitee plane).
 *
 * The relay already filters to actionable invites (active, addressed to the
 * caller's verified email, declines excluded), so there is no client-side
 * pending-filter here — shaping is display-only, and the bell count is
 * simply "how many rows".
 */

import type { RigMyInvite } from '@shared/rig/rig-share';

export type MyInviteRow = {
  id: string;
  bindingId: string;
  /** The rig's name, strong in the row. */
  rigName: string;
  /** Who invited — display name, else email, else an honest placeholder. */
  inviterLabel: string;
  /** Mono role chip; invitee-plane invites always grant a role, but null coerces honestly. */
  roleLabel: string;
  createdAt: string;
};

export function shapeMyInvites(invites: RigMyInvite[]): MyInviteRow[] {
  return invites.map((invite) => ({
    id: invite.id,
    bindingId: invite.binding.id,
    rigName: invite.binding.name?.trim() ? invite.binding.name : 'Unnamed rig',
    inviterLabel: invite.inviter.name ?? invite.inviter.email ?? 'Someone',
    roleLabel: invite.role ?? 'member',
    createdAt: invite.createdAt,
  }));
}

export type BellState = {
  /** The bell renders at all only when signed in — never for signed-out users. */
  visible: boolean;
  /** Pending-invite count; the accent dot shows only when > 0 (no badge-zero). */
  count: number;
};

export function deriveBellState(signedIn: boolean, inviteCount: number | null): BellState {
  if (!signedIn) return { visible: false, count: 0 };
  return { visible: true, count: inviteCount ?? 0 };
}

// ── query-key scoping (feedback round fix) ──────────────────────────────────
//
// The bell's own investigation: "invited hugo@orchardstreet.xyz from one
// personal account, signed into the app as that new email, the bell says
// 'No pending invites'." The relay side checked out fine (a real,
// unrevoked invite for that address existed). The client-side gap was this
// query's OWN cache key having no account dimension at all — every signed-
// in account shared the exact same `['rig','share','myInvites']` entry, so
// switching accounts mid-session could keep showing whatever the PREVIOUS
// account's fetch had left there (react-query only refetches a still-fresh
// cache entry on an explicit invalidate or a trigger like window focus —
// neither necessarily fires just from `enabled` flipping account to
// account) rather than an honest "haven't checked yet" for the new one.

/**
 * Base prefix — every account-scoped key from `myInvitesQueryKey` below
 * shares it, so `invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX })`
 * (accept/decline, `home.tsx`'s own inline accept) still invalidates
 * whichever account-suffixed entry is actually live, without needing to
 * know which account that is.
 */
export const MY_INVITES_KEY_PREFIX = ['rig', 'share', 'myInvites'] as const;

/**
 * The actual `useQuery` key: the account id (or `null` while signed out, or
 * while signed in but the id hasn't resolved yet) makes a different account
 * a genuinely different cache entry, so there is no stale data to show
 * FROM — the fix is structural, not a matter of remembering to invalidate
 * on every sign-in/sign-out call site.
 */
export function myInvitesQueryKey(accountId: string | null): readonly unknown[] {
  return [...MY_INVITES_KEY_PREFIX, accountId];
}

/**
 * The bell's (and Home's) empty-state copy. Naming the email the search
 * actually ran against turns a silent address mismatch — the other half of
 * the same bug report — into something the reader can act on themselves
 * ("oh, that invite went to my OTHER email") rather than a dead end. `null`
 * (email unknown — `rpc.rig.account.me()` hasn't resolved, or failed)
 * degrades to the plain original copy.
 */
export function emptyInvitesMessage(email: string | null): string {
  return email ? `No pending invites for ${email}.` : 'No pending invites.';
}
