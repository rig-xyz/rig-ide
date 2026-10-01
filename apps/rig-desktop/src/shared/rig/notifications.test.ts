import { describe, expect, it } from 'vitest';
import {
  AWAY_IDLE_SECONDS,
  decideBanner,
  DEFAULT_NOTIFICATION_PREFS,
  dockCount,
  normalizeNotificationPrefs,
  openTargetOf,
  type BannerContext,
} from './notifications';
import { NOW, row } from './notification-fixture';


const ctx = (overrides: Partial<BannerContext> = {}): BannerContext => ({
  prefs: DEFAULT_NOTIFICATION_PREFS,
  level: 'all',
  appFocused: false,
  viewingBindingId: null,
  idleSeconds: 0,
  now: NOW,
  ...overrides,
});

describe('decideBanner', () => {
  it('shows a fresh unread row when you are away', () => {
    expect(decideBanner(row(), ctx())).toEqual({ show: true });
  });

  it('follows the master switch and the type toggles', () => {
    expect(decideBanner(row(), ctx({ prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: false } }))).toMatchObject({
      reason: 'disabled',
    });
    const noMessages = { ...DEFAULT_NOTIFICATION_PREFS, types: { ...DEFAULT_NOTIFICATION_PREFS.types, message: false } };
    expect(decideBanner(row(), ctx({ prefs: noMessages }))).toMatchObject({ reason: 'type' });
    expect(decideBanner(row({ type: 'mention', tier: 'direct' }), ctx({ prefs: noMessages }))).toEqual({ show: true });
    expect(decideBanner(row({ type: 'reaction', tier: 'direct' }), ctx())).toMatchObject({ reason: 'type' });
  });

  it('never banners a row that is already read or older than ten minutes', () => {
    expect(decideBanner(row({ readAt: new Date(NOW).toISOString() }), ctx())).toMatchObject({ reason: 'read' });
    expect(decideBanner(row({ createdAt: new Date(NOW - 11 * 60_000).toISOString() }), ctx())).toMatchObject({
      reason: 'stale',
    });
  });

  it('keeps a muted space quiet, even for mentions', () => {
    expect(decideBanner(row({ type: 'mention', tier: 'direct' }), ctx({ level: 'nothing' }))).toMatchObject({
      reason: 'muted',
    });
    expect(decideBanner(row({ type: 'invite', tier: 'direct', bindingId: null }), ctx({ level: 'nothing' }))).toEqual({
      show: true,
    });
  });

  it('stays quiet about the space you are looking at', () => {
    expect(decideBanner(row(), ctx({ appFocused: true, viewingBindingId: 'bnd_a', idleSeconds: 999 }))).toMatchObject({
      reason: 'viewing',
    });
    // Not focused: you aren't looking at it, whatever is on screen.
    expect(decideBanner(row(), ctx({ appFocused: false, viewingBindingId: 'bnd_a' }))).toEqual({ show: true });
  });

  it('only when away: focused and active is quiet; idle or unfocused shows', () => {
    expect(decideBanner(row(), ctx({ appFocused: true, idleSeconds: 10 }))).toMatchObject({ reason: 'present' });
    expect(decideBanner(row(), ctx({ appFocused: true, idleSeconds: AWAY_IDLE_SECONDS }))).toEqual({ show: true });
    const always = { ...DEFAULT_NOTIFICATION_PREFS, onlyWhenAway: false };
    expect(decideBanner(row(), ctx({ prefs: always, appFocused: true, idleSeconds: 10 }))).toEqual({ show: true });
  });
});

describe('dockCount', () => {
  const space = (level: 'all' | 'mentions' | 'nothing', spaceUnread: number, directUnread: number, noMessage: number) => ({
    bindingId: `bnd_${level}`,
    level,
    lastReadSeq: 0,
    spaceUnread,
    directUnread,
    directUnreadNoMessage: noMessage,
  });

  it('counts each space by its level, plus invites, without counting a mention twice', () => {
    expect(
      dockCount({
        spaces: [space('all', 4, 2, 1), space('mentions', 9, 3, 0), space('nothing', 7, 5, 2)],
        invitesUnread: 1,
        directUnreadTotal: 10,
      })
    ).toBe(4 + 1 + 3 + 0 + 1);
  });
});

describe('prefs and targets', () => {
  it('normalizes partial or broken prefs to the defaults', () => {
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    const p = normalizeNotificationPrefs({ sound: false, types: { message: false, mention: 'yes' } });
    expect(p.sound).toBe(false);
    expect(p.types.message).toBe(false);
    expect(p.types.mention).toBe(true);
  });

  it('opens a space at the row, never for an invite', () => {
    expect(openTargetOf(row({ path: 'docs/a.md' }))).toEqual({
      bindingId: 'bnd_a',
      messageId: 'msg_1',
      messageSeq: 10,
      runId: null,
      path: 'docs/a.md',
    });
    expect(openTargetOf(row({ type: 'invite', bindingId: null }))).toBeNull();
  });
});
