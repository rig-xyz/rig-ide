/**
 * One set of time labels for the conversation surfaces (the Room, doc
 * comments): a clock time in the OS's own 12/24h style, a day label for
 * separators, a short relative age, and the full date for tooltips.
 * Everything takes an ISO string or a Date and returns '' for anything
 * unparseable, so callers never render "Invalid Date".
 */

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "14:04" or "2:04 PM", whichever the OS locale uses. */
export function formatClock(value: string | Date): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

/** A stable key for "same calendar day" in local time. */
export function dayKey(value: string | Date): string {
  const date = toDate(value);
  return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : '';
}

/** "Today", "Yesterday", a weekday within the last week, else "Tue, Sep 23" (with the year when it isn't this year). */
export function formatDayLabel(value: string | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "now", "5m", "3h", "2d", then the short date. */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "Tuesday, September 23, 2026 at 2:04 PM" — for a tooltip on any shorter label. */
export function formatFull(value: string | Date): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}
