/**
 * "Delete a rig" (rigs-rail row menu → confirm dialog → main-process
 * orchestration) — pure types and copy/derivation logic shared by:
 *   - `renderer/features/home/rigs-rail.tsx`'s row menus (Delete vs Leave
 *     label);
 *   - `renderer/features/home/delete-rig-dialog.tsx` (the confirm dialog's
 *     title/body copy);
 *   - `main/rig/delete-rig.ts` (the failure messages a relay call maps to).
 *
 * Kept dependency-free (no Electron, no relay client, no React) so every
 * derivation here is directly unit-testable as plain data in, data out.
 */

/**
 * What the confirm dialog actually does on submit:
 *   - `'delete'` — the caller owns the binding; the relay binding is
 *     deleted too (`DELETE /v1/me/bindings/:bindingId`), and everyone else
 *     loses access.
 *   - `'leave'` — the caller is a known non-owner member; leaves the
 *     binding (`POST /v1/me/bindings/:bindingId/leave`) — the rig stays for
 *     everyone else.
 *   - `'local'` — the caller's role on this binding isn't known yet
 *     (`rpc.rig.account.workspaces()` still loading/unreachable, or this
 *     bindingId genuinely isn't in that list) — no relay call at all, only
 *     the local half (stop syncing, forget the `rig_rigs` row, optionally
 *     trash the folder).
 */
export type DeleteRigMode = 'delete' | 'leave' | 'local';

/**
 * `role` is this account's role on the binding, straight from
 * `rpc.rig.account.workspaces()` (`null` when unknown — see
 * `home-sections.ts`'s `HomeRigRow`'s own doc comment on when that
 * happens). Mirrors `deriveRelayOnlyRowStatus`'s own "unknown role is never
 * assumed to be an owner OR a known member" caution — everything that isn't
 * confidently `'owner'` falls to `'leave'` once a role IS known, and to
 * `'local'` only when it genuinely isn't known at all.
 */
export function deriveDeleteRigMode(role: string | null): DeleteRigMode {
  if (role === null) return 'local';
  return role === 'owner' ? 'delete' : 'leave';
}

/**
 * The row menu's own label (`rigs-rail.tsx`'s row menus) — "Delete rig…"
 * for both `'delete'` and `'local'` (an unknown role still reads as delete
 * from THIS Mac's point of view: forgetting a local rig you don't
 * confidently know your role on is unambiguously "delete it here"), "Leave
 * rig…" only for a confidently-known non-owner member.
 */
export function deriveRigMenuLabel(mode: DeleteRigMode): string {
  return mode === 'leave' ? 'Leave rig…' : 'Delete rig…';
}

/** The confirm dialog's title + body — verbatim strings, no markup. */
export type DeleteRigCopy = {
  title: string;
  body: string;
};

function personWord(count: number): string {
  return count === 1 ? 'person' : 'people';
}

/**
 * The confirm dialog's title + body (`delete-rig-dialog.tsx`). `name` falls
 * back to "this rig" so a row with no known display name never renders a
 * blank title. `memberCount` is every OTHER member on the binding — the
 * caller's own row is never counted (see `main/rig/delete-rig.ts`'s doc
 * comment on why `members.length - 1` is an honest count without needing to
 * identify which member row is "you") — `null` while that count is still
 * loading, or for `'local'` mode, which makes no relay call and so has
 * nothing to count.
 */
export function deriveDeleteRigCopy(input: {
  mode: DeleteRigMode;
  name: string | null;
  memberCount: number | null;
}): DeleteRigCopy {
  const name = input.name ?? 'this rig';

  if (input.mode === 'local') {
    return {
      title: `Delete ${name}?`,
      body: 'Removes it from your rigs on this computer.',
    };
  }

  if (input.mode === 'leave') {
    // `memberCount` already excludes the caller; the owner is always one of
    // the remaining members (a non-owner is leaving, so there is one), so
    // subtracting one more gives "the other people" the body names
    // separately from "its owner".
    const others = Math.max(0, (input.memberCount ?? 0) - 1);
    const body =
      others > 0
        ? `Stops syncing on this computer. You'll lose access; the rig stays for its owner and the other ${others} ${personWord(others)}.`
        : "Stops syncing on this computer. You'll lose access; the rig stays for its owner.";
    return { title: `Leave ${name}?`, body };
  }

  const count = input.memberCount ?? 0;
  const body =
    count > 0
      ? `Stops syncing on this computer. Removes the rig for everyone: ${count} ${personWord(count)} will lose access.`
      : 'Stops syncing on this computer. Removes the rig for everyone. Nobody else has access.';
  return { title: `Delete ${name}?`, body };
}

/** The folder line's caption, shown only while "move to Trash" is unchecked. */
export function deriveFolderKeptNote(path: string): string {
  return `Your files stay in ${path}.`;
}

/** The confirm dialog's submit button label — no ellipsis, unlike the menu item / title. */
export function deriveDeleteRigButtonLabel(mode: DeleteRigMode): string {
  return mode === 'leave' ? 'Leave rig' : 'Delete rig';
}

/** Why a relay call for `delete`/`leave` failed — drives `deriveDeleteRigFailureMessage`'s exact copy. */
export type DeleteRigFailureKind = 'forbiddenOwnerOnly' | 'ownerCannotLeave' | 'network' | 'other';

/**
 * The confirm dialog's inline error text for a failed relay call
 * (`main/rig/delete-rig.ts`'s `deleteRigImpl`, verbatim from the brief):
 * the two relay-specific codes get their own sentence pointing at the other
 * action; anything else (an unreachable relay, a 5xx, a body that didn't
 * parse) gets a generic retry line worded for the action actually being
 * attempted.
 */
export function deriveDeleteRigFailureMessage(kind: DeleteRigFailureKind, mode: DeleteRigMode): string {
  if (kind === 'forbiddenOwnerOnly') return 'Only the owner can delete this rig. You can leave it instead.';
  if (kind === 'ownerCannotLeave') return "The owner can't leave; delete the rig instead.";
  return mode === 'leave' ? "Couldn't leave this rig. Try again." : "Couldn't delete this rig. Try again.";
}

/** `rpc.rig.rigs.delete`'s input — see `main/rig/delete-rig.ts`'s own header comment for the step ordering. */
export type DeleteRigInput = {
  bindingId: string;
  /** `null` for a relay-only row with no known local folder — skips the stop-sync and trash steps entirely. */
  path: string | null;
  mode: DeleteRigMode;
  /** Ignored when `path` is `null`. */
  trashFolder: boolean;
};

export type DeleteRigFailure = {
  kind: DeleteRigFailureKind | 'localFailure';
  message: string;
};

export type DeleteRigSuccess = {
  /**
   * Non-null when `trashFolder` was requested but the actual move-to-Trash
   * call failed — the rig is still fully deleted/left/forgotten regardless
   * (see the brief: "if trashing fails, report it but treat the rig as
   * deleted"), this is only a heads-up for the dialog to show alongside its
   * otherwise-successful close.
   */
  trashWarning: string | null;
};
