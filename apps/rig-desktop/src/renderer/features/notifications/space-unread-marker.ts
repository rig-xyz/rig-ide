import type { NotificationLevel } from '@shared/rig/notifications';

/**
 * Home's space-row badge (`notifications-spec.md` §5, "Rail and Home
 * badges"): a muted space (`level === 'nothing'`) shows no badge and a
 * dimmed name, since its mentions wait in Activity instead; otherwise a red
 * count for unread rows about you (mentions, replies, your agent,
 * requests), else a quiet dot for ordinary room activity.
 *
 * Pure, so the decision has one place to test.
 */

export type SpaceUnreadMarker = { kind: 'count'; n: number } | { kind: 'dot' } | { kind: 'none'; dimmed: boolean };

export function spaceUnreadMarker(
  summary: { level: NotificationLevel; spaceUnread: number; directUnread: number } | undefined
): SpaceUnreadMarker {
  if (!summary) return { kind: 'none', dimmed: false };
  if (summary.level === 'nothing') return { kind: 'none', dimmed: true };
  if (summary.directUnread > 0) return { kind: 'count', n: summary.directUnread };
  if (summary.spaceUnread > 0) return { kind: 'dot' };
  return { kind: 'none', dimmed: false };
}

/** "99+" cap for a count pill — `spaceUnread` is capped the same way server-side. */
export function formatUnreadCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}
