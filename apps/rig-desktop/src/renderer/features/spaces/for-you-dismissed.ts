/**
 * The asks you checked off in For you, remembered on this computer per Space
 * (`rig-for-you-dismissed:<bindingId>`, a JSON list of inbox row ids, newest
 * last). Storage isn't guaranteed: every read and write is guarded, and a
 * Room without it just shows a dismissed ask again next time.
 */

const KEY_PREFIX = 'rig-for-you-dismissed:';
/** The oldest are forgotten past this: an old row is long out of the inbox's page anyway. */
export const DISMISSED_CAP = 500;

export function readDismissed(bindingId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + bindingId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** `ids` added to the Space's list (newest last, capped), returned as the new list. */
export function addDismissed(bindingId: string, ids: readonly string[]): string[] {
  const current = readDismissed(bindingId);
  const known = new Set(current);
  const next = [...current, ...ids.filter((id) => !known.has(id))].slice(-DISMISSED_CAP);
  try {
    localStorage.setItem(KEY_PREFIX + bindingId, JSON.stringify(next));
  } catch {
    // Not remembered next time; this session still hides it.
  }
  return next;
}
