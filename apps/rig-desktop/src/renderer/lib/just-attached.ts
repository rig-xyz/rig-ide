/**
 * A single-slot handoff from "just ran `rig attach`" to `App.tsx`'s
 * `openPath` — NOT a prop threaded through `onOpenPath`. `onOpenPath` is a
 * plain `(path: string) => void` callback passed down through five-plus
 * component layers (`Home` → `RigsRail` → `RelayOnlyRigRow` →
 * `RelayOnlyActionsMenu`, and separately `InvitesBell` → `InviteRow`);
 * widening its signature everywhere just to carry one boolean that only
 * TWO of its many call sites ever have would ripple across files that have
 * nothing to do with attach/sync. This tiny module is the surgical
 * alternative: the attach call site stashes the fact right before calling
 * `onOpenPath`, and `openPath` (the one place that already resolves the
 * real `workspaceRoot` via `rpc.rig.workspace.detect`) consumes it — a
 * same-tick handoff, single window app, no persistence, no real state
 * machine.
 */

let pending: { path: string; syncing: boolean } | null = null;

/** Called by a "Download"/"Set up locally" action right after a successful `rig attach`, before it calls `onOpenPath`. */
export function markJustAttachedSyncing(path: string, syncing: boolean): void {
  pending = { path, syncing };
}

/** Called once by `App.tsx`'s `openPath`, keyed off the freshly-detected `workspaceRoot`. One-shot: cleared on read regardless of match, so a later plain open of the SAME path never inherits a stale attach. */
export function consumeJustAttachedSyncing(path: string): boolean {
  const match = pending?.path === path ? pending.syncing : false;
  pending = null;
  return match;
}
