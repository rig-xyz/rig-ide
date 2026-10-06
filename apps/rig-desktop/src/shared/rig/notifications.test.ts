import { describe, expect, it } from 'vitest';
import {
  decideBanner,
  DEFAULT_NOTIFICATION_PREFS,
  dockCount,
  normalizeNotificationPrefs,
  directPhrase,
  openTargetOf,
  type BannerContext,
} from './notifications';
import { NOW, row } from './notification-fixture';


const ctx = (overrides: Partial<BannerContext> = {}): BannerContext => ({
  prefs: DEFAULT_NOTIFICATION_PREFS,
  level: 'all',
  appFocused: false,
  viewingBindingId: null,
  now: NOW,
  ...overrides,
});

describe('decideBanner', () => {
  it('shows a fresh unread row when you are away', () => {
    expect(decideBanner(row(), ctx())).toEqual({ show: true });
  });

  it("follows 'Show banners for': Nothing, or About me only", () => {
    expect(decideBanner(row(), ctx({ prefs: { ...DEFAULT_NOTIFICATION_PREFS, banners: 'nothing' } }))).toMatchObject({
      reason: 'disabled',
    });
    const aboutMe = { ...DEFAULT_NOTIFICATION_PREFS, banners: 'aboutMe' as const };
    expect(decideBanner(row(), ctx({ prefs: aboutMe }))).toMatchObject({ reason: 'type' });
    expect(decideBanner(row({ type: 'mention', tier: 'direct' }), ctx({ prefs: aboutMe }))).toEqual({ show: true });
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
    expect(decideBanner(row(), ctx({ appFocused: true, viewingBindingId: 'bnd_a', prefs: { ...DEFAULT_NOTIFICATION_PREFS, onlyWhenAway: false } }))).toMatchObject({
      reason: 'viewing',
    });
    // Not focused: you aren't looking at it, whatever is on screen.
    expect(decideBanner(row(), ctx({ appFocused: false, viewingBindingId: 'bnd_a' }))).toEqual({ show: true });
  });

  it('only when away: any focused rig window is quiet; unfocused shows', () => {
    expect(decideBanner(row(), ctx({ appFocused: true }))).toMatchObject({ reason: 'present' });
    expect(decideBanner(row(), ctx({ appFocused: false }))).toEqual({ show: true });
    const always = { ...DEFAULT_NOTIFICATION_PREFS, onlyWhenAway: false };
    expect(decideBanner(row(), ctx({ prefs: always, appFocused: true }))).toEqual({ show: true });
  });

  it("while you're at another of your Macs, the banner shows there, not here", () => {
    expect(decideBanner(row(), ctx({ usingAnotherMac: true }))).toMatchObject({ reason: 'elsewhere' });
    const always = { ...DEFAULT_NOTIFICATION_PREFS, onlyWhenAway: false };
    expect(decideBanner(row(), ctx({ prefs: always, usingAnotherMac: true }))).toMatchObject({ reason: 'elsewhere' });
    expect(decideBanner(row(), ctx({ usingAnotherMac: false }))).toEqual({ show: true });
  });
});

describe('dockCount', () => {
  it('is the bell: unread rows about you, invites included, whatever each space level', () => {
    expect(
      dockCount({
        spaces: [
          { bindingId: 'a', name: null, latestDirect: null, level: 'all', lastReadSeq: 0, spaceUnread: 40, directUnread: 2, directUnreadNoMessage: 1 },
          { bindingId: 'b', name: null, latestDirect: null, level: 'nothing', lastReadSeq: 0, spaceUnread: 7, directUnread: 1, directUnreadNoMessage: 0 },
        ],
        invitesUnread: 1,
        directUnreadTotal: 4,
      })
    ).toBe(4);
  });
});

describe('prefs and targets', () => {
  it('normalizes partial or broken prefs to the defaults', () => {
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    const p = normalizeNotificationPrefs({ sound: false, banners: 'aboutMe' });
    expect(p).toMatchObject({ sound: false, banners: 'aboutMe' });
    // Prefs saved before the one choice migrate.
    expect(normalizeNotificationPrefs({ enabled: false }).banners).toBe('nothing');
    expect(normalizeNotificationPrefs({ enabled: true, types: { message: false, comment: false } }).banners).toBe('aboutMe');
    expect(normalizeNotificationPrefs({ enabled: true, types: { message: false } }).banners).toBe('everything');
  });

  it('opens a space at the row, never for an invite', () => {
    expect(openTargetOf(row({ path: 'docs/a.md' }))).toEqual({
      bindingId: 'bnd_a',
      spaceName: 'Launch',
      messageId: 'msg_1',
      messageSeq: 10,
      preview: 'hello',
      runId: null,
      path: 'docs/a.md',
    });
    expect(openTargetOf(row({ type: 'invite', bindingId: null }))).toBeNull();
  });
});

describe('directPhrase', () => {
  it('says who did what, without the space', () => {
    expect(directPhrase(row({ type: 'mention', tier: 'direct' }))).toBe('Hugo mentioned you');
    expect(directPhrase(row({ type: 'reply', tier: 'direct' }))).toBe('Hugo replied to you');
    expect(
      directPhrase(row({ type: 'agent_request', tier: 'direct', actor: { kind: 'user', userId: 'u', name: 'Maya', agent: 'codex' } }))
    ).toBe('Maya asked your Codex');
    expect(
      directPhrase(row({ type: 'agent_waiting', tier: 'direct', actor: { kind: 'agent', userId: 'u', name: 'Me', agent: 'claude' } }))
    ).toBe('Claude needs your approval');
    expect(directPhrase(row({ type: 'comment', tier: 'direct', actor: { kind: 'guest', userId: null, name: null, agent: null } }))).toBe(
      'A guest commented on your link'
    );
  });
});
