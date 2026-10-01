import { err, ok } from '@emdash/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFS,
  type RigNotification,
  type RigNotificationSummary,
} from '@shared/rig/notifications';
import { row } from '@shared/rig/notification-fixture';
import { BannerPresenter } from './presenter';
import { NotificationService, reconnectDelayMs, type NotificationServiceDeps } from './service';
import type { ListQuery } from './relay';
import type { SseEvent } from './sse';

const fresh = () => new Date().toISOString();

function setup(opts: { rows?: RigNotification[]; cursor?: string | null; summary?: RigNotificationSummary } = {}) {
  let rows = opts.rows ?? [];
  const cursors = new Map<string, string>();
  if (opts.cursor !== undefined && opts.cursor !== null) cursors.set('u_me', opts.cursor);
  const presented: string[] = [];
  const badges: number[] = [];
  const queries: ListQuery[] = [];
  let pushEvent: ((e: SseEvent) => void) | null = null;
  let endStream: (() => void) | null = null;
  const summary: RigNotificationSummary = opts.summary ?? {
    spaces: [{ bindingId: 'bnd_a', name: null, latestDirect: null, level: 'all', lastReadSeq: 0, spaceUnread: 3, directUnread: 1, directUnreadNoMessage: 1 }],
    invitesUnread: 0,
    directUnreadTotal: 1,
  };
  const presenter = new BannerPresenter({
    factory: () => ({ close() {} }),
    now: () => Date.now(),
    sound: () => true,
    onClick: () => {},
  });
  const present = vi.spyOn(presenter, 'present').mockImplementation((r) => presented.push(r.id));
  const closeAll = vi.spyOn(presenter, 'closeAll');
  const closeIds = vi.spyOn(presenter, 'closeIds');
  let prefs = DEFAULT_NOTIFICATION_PREFS;
  let signedIn = true;
  const deps: NotificationServiceDeps = {
    context: async () => (signedIn ? ok({ url: 'https://relay.test', token: 't' }) : err({ kind: 'notSignedIn', message: 'no' } as never)),
    selfUserId: async () => 'u_me',
    list: async (q) => {
      queries.push(q);
      if (q.after === undefined) return ok(rows.slice(-1));
      return ok(rows.filter((r) => BigInt(r.id) > BigInt(q.after!)).slice(0, q.limit));
    },
    summary: async () => ok(summary),
    stream: (_url, _token, onEvent, { signal }) =>
      new Promise<void>((resolve) => {
        pushEvent = onEvent;
        endStream = resolve;
        signal.addEventListener('abort', () => resolve());
      }),
    presenter,
    setBadge: (n) => badges.push(n),
    emitChanged: () => {},
    prefs: () => prefs,
    cursor: { get: (a) => cursors.get(a) ?? null, set: (a, id) => cursors.set(a, id) },
    appFocused: () => false,
    now: () => Date.now(),
    sleep: () => new Promise((r) => setTimeout(r, 0)),
    log: { warn: () => {} },
  };
  const service = new NotificationService(deps);
  return {
    service,
    presented,
    badges,
    queries,
    cursors,
    present,
    closeAll,
    closeIds,
    setRows: (next: RigNotification[]) => (rows = next),
    push: (e: SseEvent) => pushEvent!(e),
    endStream: () => endStream?.(),
    connected: () => vi.waitFor(() => expect(pushEvent).not.toBeNull()),
    setPrefs: (p: typeof prefs) => (prefs = p),
    signOut: () => (signedIn = false),
  };
}

let current: ReturnType<typeof setup> | null = null;
afterEach(() => {
  current?.service.stop();
  current = null;
});

describe('NotificationService', () => {
  it("starts a new account at its newest row: history never floods in as banners", async () => {
    current = setup({ rows: [row({ id: '5', createdAt: fresh() }), row({ id: '9', createdAt: fresh() })] });
    current.service.start();
    await current.connected();
    expect(current.cursors.get('u_me')).toBe('9');
    expect(current.presented).toEqual([]);
  });

  it('catches up past the cursor on connect and on each notification event, once per row', async () => {
    const t = setup({ cursor: '1', rows: [row({ id: '2', createdAt: fresh() })] });
    current = t;
    t.service.start();
    await t.connected();
    expect(t.presented).toEqual(['2']);
    t.setRows([row({ id: '2', createdAt: fresh() }), row({ id: '3', createdAt: fresh() }), row({ id: '4', createdAt: fresh() })]);
    t.push({ event: 'notification', data: '{"id":"3"}' });
    t.push({ event: 'notification', data: '{"id":"4"}' });
    await t.service.catchUp();
    expect(t.presented).toEqual(['2', '3', '4']);
    expect(t.cursors.get('u_me')).toBe('4');
  });

  it('applies the summary to the badge, and drops it when the badge setting is off', async () => {
    const t = setup({ cursor: '0' });
    current = t;
    t.service.start();
    await t.connected();
    // the bell's number: unread rows about you
    expect(t.badges.at(-1)).toBe(1);
    t.setPrefs({ ...DEFAULT_NOTIFICATION_PREFS, dockBadge: false });
    t.service.prefsChanged();
    expect(t.badges.at(-1)).toBe(0);
  });

  it('uses the space level from the summary when deciding a banner', async () => {
    const t = setup({
      cursor: '0',
      rows: [row({ id: '1', type: 'mention', tier: 'direct', createdAt: fresh() })],
      summary: {
        spaces: [{ bindingId: 'bnd_a', name: null, latestDirect: null, level: 'nothing', lastReadSeq: 0, spaceUnread: 0, directUnread: 1, directUnreadNoMessage: 0 }],
        invitesUnread: 0,
        directUnreadTotal: 1,
      },
    });
    current = t;
    t.service.start();
    await t.connected();
    expect(t.presented).toEqual([]);
    expect(t.cursors.get('u_me')).toBe('1');
  });

  it('closes banners on read events', async () => {
    const t = setup({ cursor: '0' });
    current = t;
    t.service.start();
    await t.connected();
    t.push({ event: 'read', data: '{"ids":["7","8"]}' });
    expect(t.closeIds).toHaveBeenCalledWith(['7', '8']);
    t.push({ event: 'read', data: '{"all":true}' });
    expect(t.closeAll).toHaveBeenCalled();
  });

  it('pages through a long backlog', async () => {
    const rows = Array.from({ length: 230 }, (_, i) => row({ id: String(i + 1), createdAt: fresh() }));
    const t = setup({ cursor: '0', rows });
    current = t;
    t.setPrefs({ ...DEFAULT_NOTIFICATION_PREFS, banners: 'nothing' });
    t.service.start();
    await t.connected();
    expect(t.cursors.get('u_me')).toBe('230');
    expect(t.queries.filter((q) => q.after !== undefined).map((q) => q.after)).toEqual(['0', '100', '200']);
  });

  it('signing out clears the badge and banners', async () => {
    const t = setup({ cursor: '0' });
    current = t;
    t.service.start();
    await t.connected();
    t.signOut();
    t.endStream();
    await vi.waitFor(() => expect(t.badges.at(-1)).toBe(0));
    expect(t.closeAll).toHaveBeenCalled();
  });

  it('restart (another account signed in) clears the old state and connects again', async () => {
    const t = setup({ cursor: '0' });
    current = t;
    t.service.start();
    await t.connected();
    expect(t.badges.at(-1)).toBe(1);
    const connects = t.queries.length;
    t.service.restart();
    expect(t.badges.at(-1)).toBe(0);
    expect(t.closeAll).toHaveBeenCalled();
    expect(t.service.summary().spaces).toEqual([]);
    await vi.waitFor(() => expect(t.badges.at(-1)).toBe(1));
    expect(t.queries.length).toBeGreaterThan(connects);
  });

  it('backs off reconnects up to a minute', () => {
    expect([0, 1, 2, 5, 10].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 32000, 60000]);
  });
});
