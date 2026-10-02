import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RelayApiError, RoomMemberRow, RoomMessageRow } from '@main/rig/spaces/relay-api';
import type { ThemeEvent, ThemeEventsPage, ThemesSnapshotWire } from '@shared/spaces/themes';
import { RelayRoomSource, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';

/** Room themes in the live Room: fetched on connect, on a notice and on catch-up, only while the flag is on, and never in the way of messages. */

class FakeProvider implements RealtimeProvider {
  awareness = null;
  private handlers: Record<string, Array<(...args: never[]) => void>> = {};
  connect(): void {}
  disconnect(): void {}
  destroy(): void {}
  sendStateless(): void {}
  on(event: string, cb: (...args: never[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  off(): void {}
  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) (h as (...a: unknown[]) => void)(...args);
  }
}

const MEMBERS: RoomMemberRow[] = [
  {
    userId: 'usr_me',
    clerkUserId: 'clerk_me',
    name: 'Dylan',
    email: null,
    role: 'owner',
    avatarUrl: null,
  },
];

function row(id: string, seq: number): RoomMessageRow {
  return {
    id,
    seq,
    author: { userId: 'clerk_me', name: 'Dylan', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: `message ${id}`,
    meta: null,
    createdAt: '2026-10-01T10:00:00Z',
  };
}

const SNAPSHOT: ThemesSnapshotWire = {
  enabled: true,
  themes: [
    { id: 'A', name: 'Pricing', description: 'Plans', bornSeq: 1, count: 1, lastSeq: 1 },
    { id: 'B', name: 'Launch', description: 'Date', bornSeq: 2, count: 1, lastSeq: 2 },
  ],
  assignments: { m1: { themeId: 'A', via: 'jev' }, m2: { themeId: 'B', via: 'jev' } },
  latestEventId: '10',
};

const assign = (id: string, messageId: string, themeId: string): ThemeEvent => ({
  id,
  atSeq: 3,
  type: 'assign',
  messageId,
  themeId,
  via: 'jev',
});

const page = (events: ThemeEvent[], nextCursor: string | null = null): ThemeEventsPage => ({
  events,
  nextCursor,
  lastId: events.at(-1)?.id ?? null,
});

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function open(
  relay: Partial<RelayRoomClient>,
  options: { themesEnabled?: boolean; rows?: RoomMessageRow[] } = {}
) {
  let provider: FakeProvider | null = null;
  const rows = options.rows ?? [row('m1', 1), row('m2', 2)];
  const listMessages = vi.fn(async (_b: string, query: { latest?: number; after?: string }) => {
    if (!query.after) return ok(rows);
    return ok(rows.filter((r) => r.seq > Number(query.after)));
  });
  const client: RelayRoomClient = {
    mintRealtimeTicket: async () =>
      ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () => ok(MEMBERS),
    listMessages,
    getSessionEvents: async () => err<RelayApiError>({ kind: 'relay', message: 'none' }),
    postMessage: async () => err<RelayApiError>({ kind: 'relay', message: 'no' }),
    requestOwnAgent: async () => err<RelayApiError>({ kind: 'relay', message: 'no' }),
    ...relay,
  };
  const source = new RelayRoomSource({
    bindingId: 'b1',
    spaceName: 'Growth',
    wsUrl: 'wss://relay.test/v1/realtime',
    selfUserId: 'usr_me',
    relay: client,
    createProvider: () => (provider = new FakeProvider()),
    themesEnabled: options.themesEnabled,
  });
  source.play();
  const notice = (payload: object) =>
    provider!.fire('stateless', { payload: JSON.stringify(payload) });
  return { source, client, provider: () => provider!, notice, rows };
}

/** A fake themes backend: a snapshot, and an event log served after a cursor, a page at a time. */
function backend(log: ThemeEvent[] = [], pageSize = 500) {
  const getThemes = vi.fn(async () => ok({ supported: true as const, data: SNAPSHOT }));
  const getThemeEvents = vi.fn(async (_b: string, after: string) => {
    const rest = log.filter((e) => BigInt(e.id) > BigInt(after));
    const shown = rest.slice(0, pageSize);
    return ok({
      supported: true as const,
      data: page(shown, rest.length > pageSize ? shown.at(-1)!.id : null),
    });
  });
  return { getThemes, getThemeEvents, log };
}

describe('RelayRoomSource themes', () => {
  it('fetches the snapshot on connect when the flag is on', async () => {
    const themes = backend();
    const { source } = open(themes, { themesEnabled: true });
    await flush();
    expect(themes.getThemes).toHaveBeenCalledTimes(1);
    expect(themes.getThemes).toHaveBeenCalledWith('b1');
    const state = source.getSnapshot().themes;
    expect(state?.cursor).toBe('10');
    expect(state?.list.map((t) => t.id)).toEqual(['A', 'B']);
    expect(state?.themeOf.m1).toEqual({ themeId: 'A', via: 'jev' });
  });

  it('never asks while the flag is off: not on connect, on a notice, or on catch-up', async () => {
    const themes = backend([assign('11', 'm3', 'A')]);
    const { source, provider, notice } = open(themes, { themesEnabled: false });
    await flush();
    provider().fire('connect');
    notice({ type: 'themes_changed', upTo: '11' });
    notice({ type: 'message_created', id: 'm3', seq: 3, kind: 'text' });
    await source.retryNow();
    await flush();
    expect(themes.getThemes).not.toHaveBeenCalled();
    expect(themes.getThemeEvents).not.toHaveBeenCalled();
    expect(source.getSnapshot().themes ?? null).toBeNull();
  });

  it('a themes_changed notice fetches the events after the cursor and applies them', async () => {
    const themes = backend([assign('11', 'm3', 'A'), assign('12', 'm1', 'B')]);
    const { source, notice } = open(themes, { themesEnabled: true });
    await flush();
    notice({ type: 'themes_changed', upTo: '12' });
    await flush();
    expect(themes.getThemeEvents).toHaveBeenCalledWith('b1', '10');
    const state = source.getSnapshot().themes!;
    expect(state.cursor).toBe('12');
    expect(state.list.find((t) => t.id === 'A')?.count).toBe(1); // m3 in, m1 out
    expect(state.list.find((t) => t.id === 'B')?.count).toBe(2);
    expect(state.themeOf.m3.themeId).toBe('A');
  });

  it('a notice for an event already held asks nothing', async () => {
    const themes = backend([assign('11', 'm3', 'A')]);
    const { notice } = open(themes, { themesEnabled: true });
    await flush();
    notice({ type: 'themes_changed', upTo: '10' });
    await flush();
    expect(themes.getThemeEvents).not.toHaveBeenCalled();
  });

  it('catch-up (the socket connecting, a manual retry) fetches the events after the cursor', async () => {
    const themes = backend([assign('11', 'm3', 'A')]);
    const { source, provider } = open(themes, { themesEnabled: true });
    await flush();
    provider().fire('connect');
    await flush();
    expect(themes.getThemeEvents).toHaveBeenCalledWith('b1', '10');
    expect(source.getSnapshot().themes?.cursor).toBe('11');
    themes.log.push(assign('12', 'm4', 'B'));
    await source.retryNow();
    expect(themes.getThemeEvents).toHaveBeenLastCalledWith('b1', '11');
    expect(source.getSnapshot().themes?.cursor).toBe('12');
  });

  it('follows nextCursor until the relay has no more pages', async () => {
    const log = Array.from({ length: 5 }, (_, i) => assign(String(11 + i), `n${i}`, 'A'));
    const themes = backend(log, 2);
    const { source, notice } = open(themes, { themesEnabled: true });
    await flush();
    notice({ type: 'themes_changed', upTo: '15' });
    await flush();
    expect(themes.getThemeEvents.mock.calls.map((c) => c[1])).toEqual(['10', '12', '14']);
    expect(source.getSnapshot().themes?.cursor).toBe('15');
    expect(source.getSnapshot().themes?.list.find((t) => t.id === 'A')?.count).toBe(6);
  });

  it('the same event delivered twice counts once', async () => {
    const ev = assign('11', 'm3', 'A');
    // A relay that, for some reason, keeps sending the event after it was applied.
    const getThemeEvents = vi.fn(async () => ok({ supported: true as const, data: page([ev]) }));
    const { source, provider, notice } = open(
      { getThemes: backend().getThemes, getThemeEvents },
      { themesEnabled: true }
    );
    await flush();
    notice({ type: 'themes_changed', upTo: '11' });
    await flush();
    provider().fire('connect');
    await flush();
    await source.retryNow();
    expect(getThemeEvents.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(source.getSnapshot().themes?.list.find((t) => t.id === 'A')?.count).toBe(2);
  });

  it('an unsupported relay shows no themes and is not asked again this session', async () => {
    const getThemes = vi.fn(async () => ok({ supported: false as const }));
    const getThemeEvents = vi.fn(async () => ok({ supported: false as const }));
    const { source, provider, notice } = open(
      { getThemes, getThemeEvents },
      { themesEnabled: true }
    );
    await flush();
    expect(getThemes).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().themes ?? null).toBeNull();
    notice({ type: 'themes_changed', upTo: '99' });
    provider().fire('connect');
    await source.retryNow();
    await flush();
    expect(getThemes).toHaveBeenCalledTimes(1);
    expect(getThemeEvents).not.toHaveBeenCalled();
  });

  it('a relay that loses the routes mid-session clears the themes and stops asking', async () => {
    let gone = false;
    const getThemeEvents = vi.fn(async () =>
      gone
        ? ok({ supported: false as const })
        : ok({ supported: true as const, data: page([assign('11', 'm3', 'A')]) })
    );
    const { source, notice } = open(
      { getThemes: backend().getThemes, getThemeEvents },
      { themesEnabled: true }
    );
    await flush();
    notice({ type: 'themes_changed', upTo: '11' });
    await flush();
    expect(source.getSnapshot().themes?.cursor).toBe('11');
    gone = true;
    notice({ type: 'themes_changed', upTo: '12' });
    await flush();
    expect(source.getSnapshot().themes).toBeNull();
    notice({ type: 'themes_changed', upTo: '13' });
    await flush();
    expect(getThemeEvents).toHaveBeenCalledTimes(2);
  });

  it('a themes failure (an error answer, or a throw) never breaks messages', async () => {
    for (const failure of [
      async () => err<RelayApiError>({ kind: 'relay', status: 500, message: 'boom' }),
      async () => {
        throw new Error('ipc closed');
      },
    ]) {
      const themes = {
        getThemes: failure,
        getThemeEvents: failure,
      } as unknown as Partial<RelayRoomClient>;
      const { source, notice, rows } = open(themes, { themesEnabled: true });
      await flush();
      expect(source.getSnapshot().themes ?? null).toBeNull();
      expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
      rows.push(row('m3', 3));
      notice({ type: 'themes_changed', upTo: '11' });
      notice({ type: 'message_created', id: 'm3', seq: 3, kind: 'text' });
      await flush();
      expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      expect(source.getSnapshot().relayUnreachable).toBeFalsy();
    }
  });

  it('a failed events fetch keeps the themes it has, and the next catch-up tries again', async () => {
    let fail = true;
    const getThemeEvents = vi.fn(async () =>
      fail
        ? err<RelayApiError>({ kind: 'relay', status: 500, message: 'boom' })
        : ok({ supported: true as const, data: page([assign('11', 'm3', 'A')]) })
    );
    const { source, notice } = open(
      { getThemes: backend().getThemes, getThemeEvents },
      { themesEnabled: true }
    );
    await flush();
    notice({ type: 'themes_changed', upTo: '11' });
    await flush();
    expect(source.getSnapshot().themes?.cursor).toBe('10');
    fail = false;
    await source.retryNow();
    expect(source.getSnapshot().themes?.cursor).toBe('11');
  });

  it('a relay client with no themes calls at all is simply not asked', async () => {
    const { source } = open({}, { themesEnabled: true });
    await flush();
    expect(source.getSnapshot().themes ?? null).toBeNull();
    expect(source.getSnapshot().messages).toHaveLength(2);
  });

  it('turning the flag on at runtime fetches at once, no reload; off clears and stops', async () => {
    const themes = backend([assign('11', 'm3', 'A')]);
    const { source, notice } = open(themes, { themesEnabled: false });
    await flush();
    expect(themes.getThemes).not.toHaveBeenCalled();

    source.setThemesEnabled(true);
    await flush();
    expect(themes.getThemes).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().themes?.cursor).toBe('10');

    source.setThemesEnabled(false);
    expect(source.getSnapshot().themes).toBeNull();
    notice({ type: 'themes_changed', upTo: '11' });
    await flush();
    expect(themes.getThemeEvents).not.toHaveBeenCalled();

    // On again: a fresh snapshot, not a stale cursor.
    source.setThemesEnabled(true);
    await flush();
    expect(themes.getThemes).toHaveBeenCalledTimes(2);
  });

  it('notices that arrive during the snapshot fetch are caught by one more pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getThemes = vi.fn(async () => {
      await gate;
      return ok({ supported: true as const, data: SNAPSHOT });
    });
    const themes = backend([assign('11', 'm3', 'A')]);
    const { source, notice } = open(
      { getThemes, getThemeEvents: themes.getThemeEvents },
      { themesEnabled: true }
    );
    await flush();
    notice({ type: 'themes_changed', upTo: '11' });
    await flush();
    release();
    await flush();
    expect(getThemes).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot().themes?.cursor).toBe('11');
  });
});
