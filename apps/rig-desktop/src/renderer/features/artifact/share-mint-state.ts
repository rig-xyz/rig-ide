import type { SharePermission } from '@shared/rig/share-links';

/**
 * Pure decision logic for the share popover's "toggling permission after a
 * link is already minted" fix (Dylan's feedback round): permission is baked
 * into the capability token at mint time — the same URL can't just change
 * meaning — so toggling read/comment while a minted URL is showing must
 * never leave that URL displayed next to a permission it no longer matches.
 */

export type MintedLink = { id: string; permission: SharePermission; url: string };

/** Whether selecting `nextPermission` requires minting a fresh link — true only when a link is already showing and its permission no longer matches the new selection. */
export function needsRemint(minted: MintedLink | null, nextPermission: SharePermission): boolean {
  return minted !== null && minted.permission !== nextPermission;
}

export type MintedDisplay =
  | { kind: 'none' }
  | { kind: 'updating' }
  | { kind: 'link'; link: MintedLink };

/**
 * What the minted-link area should render. `reminting` always wins with a
 * quiet "updating…" state (never the old URL, never the new one until it's
 * real). Otherwise, a minted link only ever displays when its OWN
 * permission still matches the current selection — the structural
 * guarantee that a stale URL can never be shown next to a permission it
 * doesn't apply to, independent of whether a re-mint is even in flight yet
 * (the instant the toggle is clicked, the mismatch alone hides it).
 */
export function deriveMintedDisplay(
  minted: MintedLink | null,
  selectedPermission: SharePermission,
  reminting: boolean
): MintedDisplay {
  if (reminting) return { kind: 'updating' };
  if (minted === null) return { kind: 'none' };
  if (minted.permission !== selectedPermission) return { kind: 'none' };
  return { kind: 'link', link: minted };
}

/**
 * A3 fix — which link to revoke once a re-mint resolves, decided at
 * RESOLUTION time against the CURRENT selection, never the selection that
 * was active when the re-mint was kicked off. `staleId === null` means
 * this was a first-time "Create link" mint, not a permission-toggle
 * re-mint — nothing to revoke either way.
 *
 * The user can toggle the permission again WHILE a re-mint is in flight
 * (this popover only best-effort discourages it — permission toggles are
 * disabled while minting, but a race between a click and that disabled
 * state committing is still possible). If they toggle back to the
 * permission `staleId`'s link already had, that OLD link is — by the time
 * this resolves — exactly what the current selection wants kept: revoking
 * it unconditionally (the old behavior) would leave the user with no
 * working link for their actual current choice, and orphan the
 * just-minted one server-side with nothing pointing at it. So: revoke the
 * stale link only when the fresh mint's OWN permission still matches the
 * current selection; otherwise the fresh mint itself is the one that's now
 * stale, and THAT'S what gets revoked instead — the stale link is left
 * alone.
 */
export function deriveRevokeTarget(
  staleId: string | null,
  mintedPermission: SharePermission,
  currentPermission: SharePermission,
  freshId: string
): { id: string } | null {
  if (staleId === null) return null;
  return currentPermission === mintedPermission ? { id: staleId } : { id: freshId };
}
