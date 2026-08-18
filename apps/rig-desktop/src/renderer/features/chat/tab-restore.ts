import type { RigOpenTabsState } from '@shared/rig/settings';

/**
 * Pure state for "tabs should just come back" (persistence-design.md Round D).
 * Persisted to `settings.lastOpenTabsByRig[bindingId]` (see that type's own
 * doc comment for why it lives there and not on `rig_sessions`) — this
 * module only derives what to write and reads what to restore; the actual
 * RPC calls and store construction live in `chat-panel.tsx`.
 */

/** What to persist right now, from the live tab-strip state. */
export function toOpenTabsState(
  sessionIds: readonly string[],
  activeId: string | null
): RigOpenTabsState {
  return {
    sessionIds: [...sessionIds],
    // Never persist an activeId that isn't actually one of the open tabs —
    // restoring a dangling id would silently do nothing useful.
    activeId: activeId !== null && sessionIds.includes(activeId) ? activeId : null,
  };
}

/** Whether two stored snapshots differ — skips a redundant write when nothing changed. */
export function openTabsStateEquals(a: RigOpenTabsState, b: RigOpenTabsState): boolean {
  return (
    a.activeId === b.activeId &&
    a.sessionIds.length === b.sessionIds.length &&
    a.sessionIds.every((id, i) => id === b.sessionIds[i])
  );
}
