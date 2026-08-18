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
