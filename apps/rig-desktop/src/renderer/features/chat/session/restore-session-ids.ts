/**
 * Combines persisted tabs with live stores retained outside the current panel.
 * The active tab is intentionally not derived here: a persisted `activeId` of
 * null must keep the panel in its zero-state on remount.
 */
export function mergeRestoredConversationIds(
  storedIds: readonly string[],
  retainedLiveIds: readonly string[],
  initialActiveSessionId?: string | null
): Set<string> {
  const ids = new Set([...storedIds, ...retainedLiveIds]);
  if (initialActiveSessionId) ids.add(initialActiveSessionId);
  return ids;
}
