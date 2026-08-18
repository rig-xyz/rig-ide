/**
 * Pure formatting for the History list (`persistence-design.md` Round B) and
 * the replay bar's "Session from <date>" label.
 *
 * `now` is always passed in explicitly rather than read internally — keeps
 * this testable without faking the clock, and matches the same shape as
 * `main`'s honest `at` values flowing straight through with no display-side
 * `Date.now()` standing in for a real timestamp.
 */

/** Coarse "2h ago" / "3d ago", same style as the comments margin's own local formatter. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

/** `h:mm` + lowercase `am`/`pm`, no space — matches the comments cache's own clock format. */
export function formatClockTime(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '');
}

/** `Mon D` — e.g. `Aug 12`. Empty on a bad timestamp. */
export function formatShortDate(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The replay bar's full label — e.g. "Session from Aug 12, 2:04pm". Empty on a bad timestamp. */
export function formatSessionFromLabel(at: number): string {
  const date = formatShortDate(at);
  const time = formatClockTime(at);
  if (!date) return 'Session';
  return time ? `Session from ${date}, ${time}` : `Session from ${date}`;
}
