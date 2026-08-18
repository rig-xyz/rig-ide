/**
 * Pure shaping for the share popover's "Pending invites" section. The relay's
 * invite list (`GET /v1/me/bindings/:bindingId/invites`) returns EVERY invite
 * ever minted — revoked, expired, exhausted included — newest first, and the
 * caller filters (the same contract `rig who` filters against CLI-side).
 * "Pending" here = still acceptable: not revoked, not past `expiresAt`, and
 * not used up (`maxUses` reached).
 */

import type { RigInvite, RigInviteRole, RigMember } from '@shared/rig/rig-share';

export type PendingInvite = {
  id: string;
  /** Who the invite is locked to, when it is — shown as the row's identity. */
  email: string | null;
  /** Mono role chip: the granted role, or `link` for a pure-capability invite. */
  roleLabel: string;
  createdAt: string;
};

export function isPendingInvite(invite: RigInvite, nowMs: number): boolean {
  if (invite.revokedAt !== null) return false;
  if (invite.expiresAt !== null && Date.parse(invite.expiresAt) <= nowMs) return false;
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return false;
  return true;
}

export function shapePendingInvites(invites: RigInvite[], nowMs: number): PendingInvite[] {
  return invites
    .filter((invite) => isPendingInvite(invite, nowMs))
    .map((invite) => ({
      id: invite.id,
      email: invite.emailConstraint,
      roleLabel: invite.role ?? 'link',
      createdAt: invite.createdAt,
    }));
}

/**
 * Dylan's feedback round, part (a): after an invite link is minted, the role
 * baked into it is fixed — toggling "Can edit"/"Can view" afterward must
 * never leave the OLD link on screen next to a role selection it no longer
 * grants. The file-share popover (`share-mint-state.ts`) handles this by
 * auto-re-minting for the new selection and revoking the superseded link —
 * appropriate there because a file share link is typically minted and
 * copied by the same person, for themselves, in one sitting. An invite is
 * different: by the time someone toggles the role, the link may already be
 * sitting in an email that went out, or already forwarded to the person
 * it's for — silently revoking it out from under them on an accidental
 * toggle click is a real, surprising failure, not a convenience. So this
 * just stops SHOWING the mismatched link (the underlying invite is left
 * completely alone — untouched, still valid, still visible below in
 * "Pending invites") and requires an explicit "Create link"/"Send invite"
 * click to mint a new one for the new role. Honest over clever: nothing
 * changes server-side just because a toggle got clicked.
 */
export function mintedInviteMatchesRole(
  mintedRole: string | null,
  selectedRole: RigInviteRole
): boolean {
  return mintedRole === selectedRole;
}

/**
 * People suggestions for the invite form (Dylan's "a quick way to invite
 * people he's already worked with"): distinct collaborators gathered once,
 * on popover open, across every rig the caller has (`rig.share.collaborators`
 * — main-process side does the N-bindings fan-out) minus whoever's already
 * on THIS rig and anyone with no email on file (nothing to fill the field
 * with). Filtered locally against `query` — no relay round trip per
 * keystroke, since `collaborators` is already sitting in memory by the time
 * someone starts typing.
 */
export function suggestCollaborators(
  collaborators: RigMember[],
  currentMemberIds: ReadonlySet<string>,
  query: string,
  limit = 6
): RigMember[] {
  const q = query.trim().toLowerCase();
  return collaborators
    .filter((member) => member.email !== null)
    .filter((member) => !currentMemberIds.has(member.userId))
    .filter((member) => {
      if (q.length === 0) return true;
      const name = (member.name ?? '').toLowerCase();
      const email = (member.email ?? '').toLowerCase();
      return name.includes(q) || email.includes(q);
    })
    .slice(0, limit);
}
