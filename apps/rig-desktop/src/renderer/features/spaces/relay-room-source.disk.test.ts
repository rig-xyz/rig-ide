import { err, ok } from '@emdash/shared';
import type { RelayApiError, RoomMessageRow, SessionEventRow, SessionRun } from '@main/rig/spaces/relay-api';
import { cachedRoomSchema, ROOM_CACHE_FORMAT_VERSION, type CachedRoomBlob } from '@shared/spaces/room-cache';
import type { LocalRunEvent } from '@shared/spaces/room-sees';
import { describe, expect, it, vi } from 'vitest';
import { RelayRoomSource, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';

/**
 * The disk cache, source side (rig/docs/room-disk-cache-spec.md): a Room
 * saved on one launch opens the next one at once and only catches up; what
 * it saves never holds a run's steps, thinking or tool output.
 */

const BINDING = 'b1';

function provider(): RealtimeProvider {
  return { connect: () => {}, disconnect: () => {}, destroy: () => {}, sendStateless: () => {}, on: () => {}, off: () => {}, awareness: null };
}

function row(seq: number, overrides: Partial<RoomMessageRow> = {}): RoomMessageRow {
  return {
    id: `m${seq}`,
    seq,
    author: { userId: 'u1', name: 'Alice', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: `message ${seq}`,
    meta: null,
    createdAt: '2026-09-28T09:00:00Z',
    ...overrides,
  };
}

const session = (seq: number, runId: string) => row(seq, { id: `m-${runId}`, kind: 'session', body: 'Do it', meta: { runId } });

function run(id: string, status: SessionRun['status'] = 'done', ownerUserId = 'u2'): SessionRun {
  return { id, bindingId: BINDING, ownerUserId, agent: 'claude', model: 'opus', status, title: 't', commands: null, startedAt: '', endedAt: null };
}

function event(runId: string, seq: number, kind: string, payload: Record<string, unknown>): SessionEventRow {
  return { runId, seq, kind, payload, bytes: 10, truncated: false, originalBytes: null, createdAt: '' };
}

/** A finished run with steps, thinking, tool output and an answer. */
function doneLog(runId: string): SessionEventRow[] {
  return [
    event(runId, 1, 'agent_thought_chunk', { content: { type: 'text', text: 'SECRET-THINKING' } }),
    event(runId, 2, 'tool_call', { toolCallId: 't1', kind: 'read', title: 'cat SECRET-FILE.md', rawOutput: 'SECRET-OUTPUT' }),
    event(runId, 3, 'tool_call_update', { toolCallId: 't1', status: 'completed', rawOutput: 'SECRET-OUTPUT' }),
    event(runId, 4, 'agent_message_chunk', { messageId: 'a', content: { type: 'text', text: 'The answer.' } }),
    event(runId, 5, 'turn_ended', { status: 'done' }),
  ];
}

function relayWith(log: RoomMessageRow[], runs: Record<string, { run: SessionRun; events: SessionEventRow[] }>) {
  const calls: string[] = [];
  const relay: RelayRoomClient = {
    mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () => {
      calls.push('listMembers');
      return ok([{ userId: 'u1', clerkUserId: null, name: 'Alice', email: null, role: 'owner', avatarUrl: null }]);
    },
    listInvites: async () => {
      calls.push('listInvites');
      return ok([]);
    },
    listConnectors: async () => {
      calls.push('listConnectors');
      return ok([{ connectorId: 'linear', addedBy: 'u1', addedAt: '' }]);
    },
    listMessages: async (_b, query) => {
      calls.push(query.after !== undefined ? `listMessages?after=${query.after}` : `listMessages?latest=${query.latest}`);
      const after = query.after !== undefined ? Number(query.after) : 0;
      const rows = log.filter((m) => m.seq > after);
      return ok(query.latest ? rows.slice(-query.latest) : rows);
    },
    getSessionEvents: async (_b, runId, after = 0) => {
      calls.push(`events:${runId}`);
      const entry = runs[runId];
      if (!entry) return err<RelayApiError>({ kind: 'relay', status: 404, message: 'no run' });
      return ok({ run: entry.run, events: entry.events.filter((e) => e.seq > after) });
    },
    postMessage: async () => ok(row(999)),
    requestOwnAgent: async () => ok({} as never),
  };
  return { relay, calls };
}

function open(
  relay: RelayRoomClient,
  extra: Partial<ConstructorParameters<typeof RelayRoomSource>[0]> = {}
): RelayRoomSource {
  return new RelayRoomSource({
    bindingId: BINDING,
    spaceName: '#launch',
    wsUrl: 'wss://relay.test/v1/realtime',
    selfUserId: 'u1',
    relay,
    createProvider: () => provider(),
    connectGraceMs: 60_000,
    ...extra,
  });
}

/** Opens a Room cold, lets it load everything, and returns what it would save. */
async function savedRoom(
  log: RoomMessageRow[],
  runs: Record<string, { run: SessionRun; events: SessionEventRow[] }>,
  extra: Partial<ConstructorParameters<typeof RelayRoomSource>[0]> = {}
): Promise<CachedRoomBlob> {
  const { relay } = relayWith(log, runs);
  const source = open(relay, extra);
  source.play();
  await flush();
  const blob = source.toCached();
  source.dispose();
  if (!blob) throw new Error('nothing to save');
  return blob;
}

describe('what a Room saves', () => {
  it("keeps finished runs as their hide-safe summary: never steps, thinking or tool output — and it's a valid blob", async () => {
    const blob = await savedRoom([row(1), session(2, 'r1')], { r1: { run: run('r1'), events: doneLog('r1') } });
    const json = JSON.stringify(blob);
    expect(json).not.toContain('SECRET');
    expect(blob.runs.r1).toMatchObject({ summary: { answer: 'The answer.', status: 'done', stepCount: 1 } });
    expect(cachedRoomSchema.safeParse(blob).success).toBe(true);
    expect(blob.v).toBe(ROOM_CACHE_FORMAT_VERSION);
    expect(blob.lastMessageSeq).toBe(2);
  });

  it('keeps a run still going (or waiting on an approval) as its header only', async () => {
    const blob = await savedRoom([session(1, 'live'), session(2, 'asking')], {
      live: { run: run('live', 'running'), events: [event('live', 1, 'tool_call', { toolCallId: 'x', title: 'SECRET-LIVE' })] },
      asking: {
        run: run('asking', 'running'),
        events: [event('asking', 1, 'permission_requested', { requestId: 'p', toolCall: { toolCallId: 'y', title: 'SECRET-ASK' }, options: [] })],
      },
    });
    expect(blob.runs.live).toEqual({ meta: expect.objectContaining({ id: 'live' }), live: true });
    expect(blob.runs.asking).toEqual({ meta: expect.objectContaining({ id: 'asking' }), live: true });
    expect(JSON.stringify(blob)).not.toContain('SECRET');
  });

  it("never keeps this computer's own full copy of your run — only the same summary anyone gets", async () => {
    const local: LocalRunEvent[] = [
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 't', title: 'cat SECRET-LOCAL.md', rawOutput: 'SECRET-LOCAL-OUTPUT' } },
      { seq: 2, kind: 'agent_message_chunk', payload: { messageId: 'a', content: { type: 'text', text: 'Mine.' } } },
      { seq: 3, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    const blob = await savedRoom([session(1, 'mine')], { mine: { run: run('mine', 'done', 'u1'), events: [] } }, {
      localRuns: { events: async () => local, subscribe: () => () => {} },
    });
    expect(JSON.stringify(blob)).not.toContain('SECRET');
    expect(blob.runs.mine?.summary?.answer).toBe('Mine.');
  });

  it('keeps no presence, typing, connection or your own connector state', async () => {
    const blob = await savedRoom([row(1)], {}, {
      connections: { list: async () => [{ id: 'linear', state: 'connected', account: 'me@acme.com' }] },
    });
    const json = JSON.stringify(blob);
    for (const field of ['typingUserIds', 'connection', 'online', 'me@acme.com', '"mine"', 'runsLoading']) expect(json).not.toContain(field);
    expect(blob.connectors).toEqual([expect.objectContaining({ id: 'linear' })]);
  });

  it('keeps the latest 50 messages, and only the runs they name', async () => {
    const log = [session(1, 'old'), ...Array.from({ length: 60 }, (_, i) => row(i + 2))];
    const blob = await savedRoom(log, { old: { run: run('old'), events: doneLog('old') } }, { bootstrapMessageCount: 100 });
    expect(blob.messages).toHaveLength(50);
    expect(blob.messages[0]!.seq).toBe(12);
    expect(blob.runs.old).toBeUndefined();
  });

  it('saves nothing until it has loaded, nor while run logs are still loading', async () => {
    let answer: (() => void) | null = null;
    const { relay } = relayWith([session(1, 'r1')], { r1: { run: run('r1'), events: doneLog('r1') } });
    const slow: RelayRoomClient = {
      ...relay,
      getSessionEvents: async (b, id, after) => {
        await new Promise<void>((resolve) => (answer = resolve));
        return relay.getSessionEvents(b, id, after);
      },
    };
    const source = open(slow);
    expect(source.toCached()).toBeNull(); // not loaded
    source.play();
    await flush();
    expect(source.toCached()).toBeNull(); // r1's log still out
    answer!();
    await flush();
    expect(source.toCached()).not.toBeNull();
    source.dispose();
  });

  it('is written 3 s after the Room last changed, once, however many changes came in between', async () => {
    const put = vi.fn();
    const { relay } = relayWith([row(1)], {});
    const source = open(relay, { diskCache: { put } });
    source.play();
    await flush();
    vi.useFakeTimers();
    try {
      put.mockClear();
      source.rename('#one');
      vi.advanceTimersByTime(2_000);
      source.rename('#two'); // the clock starts over
      vi.advanceTimersByTime(2_999);
      expect(put).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      source.dispose();
    }
  });

  it('is written when the Room is left, never by dispose (a forgotten space must not come back)', async () => {
    const put = vi.fn();
    const { relay } = relayWith([row(1)], {});
    const source = open(relay, { diskCache: { put } });
    source.play();
    await flush();
    source.setShown(false);
    expect(put).toHaveBeenCalledTimes(1);
    source.dispose();
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('opening from what was saved', () => {
  async function saved(): Promise<{ blob: CachedRoomBlob; log: RoomMessageRow[]; runs: Record<string, { run: SessionRun; events: SessionEventRow[] }> }> {
    const log = [row(1), session(2, 'done1'), session(3, 'live1')];
    const runs = {
      done1: { run: run('done1'), events: doneLog('done1') },
      live1: { run: run('live1', 'running'), events: [event('live1', 1, 'tool_call', { toolCallId: 'z', title: 'Reading' })] },
    };
    return { blob: await savedRoom(log, runs), log, runs };
  }

  it('shows the saved Room before a single request, marked as catching up', async () => {
    const { blob, log, runs } = await saved();
    const { relay, calls } = relayWith(log, runs);
    const source = open(relay, { initial: blob });
    const snapshot = source.getSnapshot();
    expect(calls).toEqual([]);
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.messages.map((m) => m.id)).toEqual(['m1', 'm-done1', 'm-live1']);
    expect(snapshot.sessionSummaryByRun?.done1?.answer).toBe('The answer.');
    expect(snapshot.runsLoading).toEqual({ live1: true }); // a placeholder, never a stale "running" card
    expect(snapshot.sessionEventsByRun.done1).toBeUndefined();
  });

  it('catches up with messages after the last one, the three lists, and the live runs only — never a finished one', async () => {
    const { blob, log, runs } = await saved();
    log.push(row(4));
    const { relay, calls } = relayWith(log, runs);
    const source = open(relay, { initial: blob });
    const seen: string[] = [];
    source.subscribe((e) => seen.push(e.type));
    source.play();
    await flush();
    expect(new Set(calls)).toEqual(new Set(['listMembers', 'listMessages?after=3', 'listInvites', 'listConnectors', 'events:live1']));
    expect(calls).not.toContain('events:done1');
    const snapshot = source.getSnapshot();
    expect(snapshot.stale).toBe(false);
    expect(snapshot.messages.map((m) => m.id)).toEqual(['m1', 'm-done1', 'm-live1', 'm4']);
    expect(snapshot.sessionEventsByRun.live1).toHaveLength(1);
    expect(snapshot.sessionSummaryByRun?.done1).toBeDefined();
    expect(seen[0]).toBe('room_caught_up');
    source.dispose();
  });

  it('a new message naming a new run fetches that run too', async () => {
    const { blob, log, runs } = await saved();
    log.push(session(4, 'fresh'));
    const { relay, calls } = relayWith(log, { ...runs, fresh: { run: run('fresh'), events: doneLog('fresh') } });
    const source = open(relay, { initial: blob });
    source.play();
    await flush();
    expect(calls).toContain('events:fresh');
    expect(calls).not.toContain('events:done1');
    source.dispose();
  });

  it('a gap of a full page of new messages opens the message window cold', async () => {
    const { blob, log, runs } = await saved();
    for (let i = 0; i < 200; i += 1) log.push(row(10 + i));
    const { relay, calls } = relayWith(log, runs);
    const source = open(relay, { initial: blob });
    source.play();
    await flush();
    expect(calls).toContain('listMessages?after=3');
    expect(calls).toContain('listMessages?latest=50');
    const messages = source.getSnapshot().messages;
    expect(messages).toHaveLength(50);
    expect(messages.at(-1)!.seq).toBe(209);
    expect(source.getSnapshot().stale).toBe(false);
    source.dispose();
  });

  it('a saved Room older than 14 days opens cold', async () => {
    const { blob, log, runs } = await saved();
    const { relay, calls } = relayWith(log, runs);
    const source = open(relay, { initial: { ...blob, savedAt: Date.now() - 15 * 24 * 60 * 60_000 } });
    expect(source.getSnapshot().messages).toEqual([]);
    source.play();
    await flush();
    expect(calls).toContain('listMessages?latest=50');
    expect(calls).toContain('events:done1');
    source.dispose();
  });

  it('expanding a summary-only card fetches its log, which replaces the summary', async () => {
    const { blob, log, runs } = await saved();
    const { relay, calls } = relayWith(log, runs);
    const source = open(relay, { initial: blob });
    source.play();
    await flush();
    await source.loadRunLog('done1');
    expect(calls.filter((c) => c === 'events:done1')).toHaveLength(1);
    expect(source.getSnapshot().sessionSummaryByRun?.done1).toBeUndefined();
    expect(source.getSnapshot().sessionEventsByRun.done1).toHaveLength(5);
    source.dispose();
  });

  it('the relay saying the space is gone or no longer yours: the Room says so', async () => {
    const { blob, log, runs } = await saved();
    const { relay } = relayWith(log, runs);
    const onGone = vi.fn();
    const source = open({ ...relay, listMessages: async () => err<RelayApiError>({ kind: 'relay', status: 404, message: 'not_found' }) }, {
      initial: blob,
      onGone,
    });
    source.play();
    await flush();
    expect(onGone).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('saves nothing before it has caught up', async () => {
    const { blob, log, runs } = await saved();
    const { relay } = relayWith(log, runs);
    const put = vi.fn();
    const source = open({ ...relay, listMessages: () => new Promise(() => {}) }, { initial: blob, diskCache: { put } });
    source.play();
    await flush();
    source.setShown(false);
    expect(put).not.toHaveBeenCalled();
    source.dispose();
  });
});

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
