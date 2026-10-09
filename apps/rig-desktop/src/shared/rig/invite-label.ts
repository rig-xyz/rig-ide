/** What an invite is to: a space, a plain rig, or unknown (an older relay that doesn't say). */
export type InviteBindingKind = 'space' | 'rig' | null;

/** Reads the relay's `binding.kind`; anything else is unknown. */
export function parseBindingKind(value: unknown): InviteBindingKind {
  return value === 'space' || value === 'rig' ? value : null;
}

/**
 * How an invite names what it's to: `#name` for a space, the plain name for
 * a rig. Unknown kind reads as a space, which is what Start fresh makes.
 */
export function inviteTargetLabel(kind: InviteBindingKind, name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  if (kind === 'rig') return trimmed || 'a shared folder';
  return trimmed ? `#${trimmed}` : 'a space';
}

/** The role an invite grants, as the Room says it: "can edit" or "can view". */
export function inviteRoleLabel(role: string | null | undefined): string {
  if (role === 'viewer') return 'can view';
  if (role === 'owner') return 'owner';
  return 'can edit';
}

/**
 * When an invite link stops working, as "Works until Oct 14", in this
 * Mac's time zone. Null for a link with no end, or a date that can't be read.
 */
export function worksUntilLabel(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Works until ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
