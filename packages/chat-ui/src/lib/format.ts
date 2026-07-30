/**
 * Formatting utilities — pure functions for human-readable strings.
 */

/** Convert a duration in milliseconds to a whole-seconds string, e.g. 3200 → "3". */
export function formatDurationSeconds(ms: number): string {
  return String(Math.floor(ms / 1000));
}

/**
 * Compact relative time from an epoch-ms timestamp: "now", "2m", "1h", "3d".
 * Clamps future/near-past to "now".
 */
export function formatRelativeTime(epochMs: number, nowMs: number = Date.now()): string {
  const deltaS = Math.floor((nowMs - epochMs) / 1000);
  if (deltaS < 60) return 'now';
  const m = Math.floor(deltaS / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
