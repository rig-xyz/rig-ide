import { describe, expect, it } from 'vitest';
import type { NotificationLevel } from '@shared/rig/notifications';
import { formatUnreadCount, spaceUnreadMarker } from './space-unread-marker';

function summary(
  overrides: Partial<{ level: NotificationLevel; spaceUnread: number; directUnread: number }> = {}
): { level: NotificationLevel; spaceUnread: number; directUnread: number } {
  return { level: 'all', spaceUnread: 0, directUnread: 0, ...overrides };
}

describe('spaceUnreadMarker', () => {
  it('no summary yet — nothing, not dimmed', () => {
    expect(spaceUnreadMarker(undefined)).toEqual({ kind: 'none', dimmed: false });
  });

  it('direct unread shows as a count, but never on a muted space (those wait in Activity)', () => {
    expect(spaceUnreadMarker(summary({ directUnread: 3 }))).toEqual({ kind: 'count', n: 3 });
    expect(spaceUnreadMarker(summary({ directUnread: 3, level: 'mentions', spaceUnread: 10 }))).toEqual({
      kind: 'count',
      n: 3,
    });
    expect(spaceUnreadMarker(summary({ directUnread: 3, level: 'nothing', spaceUnread: 10 }))).toEqual({
      kind: 'none',
      dimmed: true,
    });
  });

  it('space unread with no direct unread — a quiet dot, unless the space is muted', () => {
    expect(spaceUnreadMarker(summary({ spaceUnread: 5 }))).toEqual({ kind: 'dot' });
    expect(spaceUnreadMarker(summary({ spaceUnread: 5, level: 'mentions' }))).toEqual({ kind: 'dot' });
    expect(spaceUnreadMarker(summary({ spaceUnread: 5, level: 'nothing' }))).toEqual({
      kind: 'none',
      dimmed: true,
    });
  });

  it('a muted space with nothing direct — nothing, dimmed', () => {
    expect(spaceUnreadMarker(summary({ level: 'nothing' }))).toEqual({ kind: 'none', dimmed: true });
  });

  it('caught up, not muted — nothing, not dimmed', () => {
    expect(spaceUnreadMarker(summary())).toEqual({ kind: 'none', dimmed: false });
  });
});

describe('formatUnreadCount', () => {
  it('passes small numbers through', () => {
    expect(formatUnreadCount(0)).toBe('0');
    expect(formatUnreadCount(42)).toBe('42');
  });

  it('caps at 99+', () => {
    expect(formatUnreadCount(99)).toBe('99');
    expect(formatUnreadCount(100)).toBe('99+');
    expect(formatUnreadCount(500)).toBe('99+');
  });
});
