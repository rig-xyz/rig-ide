import { ok } from '@emdash/shared';
import type { RoomMessageRow, SessionEventRow, SessionRun } from '@main/rig/spaces/relay-api';
import type { LocalRunEvent } from '@shared/spaces/room-sees';
import { describe, expect, it, vi } from 'vitest';
import { projectSessionCard } from './projection';
import { RelayRoomSource, type LocalRunsClient, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';

/**
 * The owner overlay: your own runs show from this computer's full copy, not
 * the relay's filtered one, and still follow along as events land.
 */

const BINDING = 'b1';
const ME = 'u1';

function provider(): RealtimeProvider {
  return {
    connect: () => {},
    disconnect: () => {},
    destroy: () => {},
    sendStateless: () => {},
    on: () => {},
    off: () => {},
    awareness: null,
  };
}

function sessionMessage(runId: string, seq: number): RoomMessageRow {
  return {
    id: `msg-${runId}`,
    seq,
    author: { userId: ME, name: 'Alice', avatarUrl: null, kind: 'user' },
    kind: 'session',
    body: 'What did the board say?',
    meta: { runId },
    createdAt: '2026-09-25T09:00:00Z',
  };
}

function run(id: string, ownerUserId: string): SessionRun {
  return {
    id,
    bindingId: BINDING,
    ownerUserId,
    agent: 'claude',
    model: 'opus',
    status: 'running',
    title: 'What did the board say?',
    commands: null,
    startedAt: '2026-09-25T09:00:00Z',
    endedAt: null,
  };
}

const row = (seq: number, kind: string, payload: Record<string, unknown>): SessionEventRow => ({
  runId: 'x',
  seq,
  kind,
  payload,
  bytes: 0,
  truncated: false,
  originalBytes: null,
  createdAt: '',
});

/** What the relay holds at Steps: a label and a lock. */
const RELAY_EVENTS = [
  row(1, 'run_privacy', { level: 'steps' }),
  row(2, 'tool_call', { toolCallId: 'g1', kind: 'other', title: 'mcp__granola__list_meetings', private: true }),
];

/** What this computer holds: everything, the approval with its real command included. */
const LOCAL_EVENTS: LocalRunEvent[] = [
  { seq: 1, kind: 'run_privacy', payload: { level: 'steps' } },
  { seq: 2, kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: 'Checking the board notes' } } },
  { seq: 3, kind: 'tool_call', payload: { toolCallId: 'g1', kind: 'other', title: 'mcp__granola__list_meetings', rawOutput: 'Bob asked for 180k' } },
  {
    seq: 4,
    kind: 'permission_requested',
    payload: {
      requestId: 'p1',
      toolCall: { toolCallId: 'b1', title: 'cat notes/board.md' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
  },
];

function setup(opts: { runs: Array<{ id: string; owner: string }>; local: Map<string, LocalRunEvent[]> }) {
  let listener: ((u: { bindingId: string; runId: string; event: LocalRunEvent }) => void) | null = null;
  const relayFetches: string[] = [];
  const relay: RelayRoomClient = {
    mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () => ok([{ userId: ME, clerkUserId: null, name: 'Alice', email: null, role: 'owner', avatarUrl: null }]),
    listMessages: async (_b, query) =>
      ok(query.after ? [] : opts.runs.map((r, i) => sessionMessage(r.id, i + 1))),
    getSessionEvents: async (_b, runId) => {
      relayFetches.push(runId);
      const owner = opts.runs.find((r) => r.id === runId)!.owner;
      return ok({ run: run(runId, owner), events: RELAY_EVENTS });
    },
    postMessage: async () => ok(sessionMessage('none', 99)),
    requestOwnAgent: async () => ok({} as never),
  };
  const localRuns: LocalRunsClient = {
    events: async (runId) => opts.local.get(runId)?.slice() ?? null,
    subscribe: (l) => {
      listener = l;
      return () => (listener = null);
    },
  };
  const source = new RelayRoomSource({
    bindingId: BINDING,
    spaceName: '#launch',
    wsUrl: 'wss://relay',
    selfUserId: ME,
    relay,
    localRuns,
    createProvider: () => provider(),
    connectGraceMs: 60_000,
  });
  const push = (runId: string, event: LocalRunEvent) => {
    opts.local.set(runId, [...(opts.local.get(runId) ?? []), event]);
    listener?.({ bindingId: BINDING, runId, event });
  };
  return { source, push, relayFetches, card: (runId: string) => projectSessionCard(source.getSnapshot().sessionEventsByRun[runId] ?? []) };
}

describe('RelayRoomSource: the owner overlay', () => {
  it("shows your own run from this computer's full copy: thinking, the real approval, what the tool returned", async () => {
    const { source, card } = setup({
      runs: [{ id: 'mine', owner: ME }, { id: 'theirs', owner: 'u2' }],
      local: new Map([['mine', LOCAL_EVENTS]]),
    });
    source.play();
    await vi.waitFor(() => expect(source.getSnapshot().sessionEventsByRun.mine?.length).toBe(4));

    const mine = card('mine');
    expect(mine.thinking).toBe('Checking the board notes');
    expect(mine.permissions.pending[0]).toMatchObject({ title: 'cat notes/board.md', options: [{ optionId: 'allow' }] });
    expect(mine.steps[0]?.private).toBeUndefined();
    // Someone else's run still reads the relay's filtered copy.
    expect(card('theirs').steps[0]).toMatchObject({ private: true });
    source.dispose();
  });

  it('follows your run as its events land, and reloads the whole copy on a gap', async () => {
    const local = new Map([['mine', LOCAL_EVENTS]]);
    const { source, push, card } = setup({ runs: [{ id: 'mine', owner: ME }], local });
    source.play();
    await vi.waitFor(() => expect(source.getSnapshot().sessionEventsByRun.mine?.length).toBe(4));

    push('mine', { seq: 5, kind: 'permission_decided', payload: { requestId: 'p1', toolCallId: 'b1', optionId: 'allow', outcome: 'allowed' } });
    await vi.waitFor(() => expect(card('mine').permissions.pending).toEqual([]));

    // seq 6 never reached this window: seq 7 finds the gap and reloads.
    local.set('mine', [...local.get('mine')!, { seq: 6, kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text: 'Approved.' } } }]);
    push('mine', { seq: 7, kind: 'turn_ended', payload: { status: 'done' } });
    await vi.waitFor(() => expect(card('mine').status).toBe('done'));
    expect(card('mine').finalAnswer).toBe('Approved.');
    expect(source.getSnapshot().sessionEventsByRun.mine?.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    source.dispose();
  });

  it('switches a run of yours that first showed from the relay to the local copy once its events arrive', async () => {
    const local = new Map<string, LocalRunEvent[]>();
    const { source, push, card } = setup({ runs: [{ id: 'mine', owner: ME }], local });
    source.play();
    await vi.waitFor(() => expect(card('mine').steps[0]?.private).toBe(true));

    for (const event of LOCAL_EVENTS) push('mine', event);
    await vi.waitFor(() => expect(card('mine').thinking).toBe('Checking the board notes'));
    expect(card('mine').steps[0]?.private).toBeUndefined();
    source.dispose();
  });
});
