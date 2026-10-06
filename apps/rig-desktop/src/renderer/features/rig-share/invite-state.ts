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
  /** The granted role as the relay has it (null for a pure-capability link); a resend mints the same. */
  role: string | null;
  /** A person invite's target (tap user id), with their name and photo. */
  targetUserId: string | null;
  targetName: string | null;
  targetAvatarUrl: string | null;
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
      role: invite.role,
      targetUserId: invite.targetUserId ?? null,
      targetName: invite.targetName ?? null,
      targetAvatarUrl: invite.targetAvatarUrl ?? null,
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
 * Dylan's feedback round, part (b): "Sam shows as a pending email invite even
 * though Sam is a member — his invite was never used because he joined
 * another way." Rather than teach the relay to reconcile that, hide it
 * client-side: an invite whose email already belongs to a current member is
 * never going to be accepted (the relay would just answer "already a
 * member"), so it shouldn't sit in "Pending invites" looking actionable.
 * Matches case-insensitively, since email addresses are compared that way in
 * practice. Open-link invites (`email: null`) have nothing to match against
 * and always stay listed. A person invite matches on its target's user id
 * (members carry no email for anyone but you).
 */
export function excludeInvitesToMembers(
  invites: PendingInvite[],
  members: RigMember[]
): PendingInvite[] {
  const memberEmails = new Set(
    members
      .map((member) => member.email)
      .filter((email): email is string => email !== null)
      .map((email) => email.toLowerCase())
  );
  const memberIds = new Set(members.map((member) => member.userId));
  return invites.filter((invite) => {
    if (invite.targetUserId !== null && memberIds.has(invite.targetUserId)) return false;
    return invite.email === null || !memberEmails.has(invite.email.toLowerCase());
  });
}
