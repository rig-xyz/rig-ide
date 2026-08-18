import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RigSessionEventRecord, RigStoredSession } from '@shared/rig/sessions';

/**
 * The replay seam: `ReplayStore.load()` reads a stored session + its
 * events over `rpc.rig.sessions.*` and seeds `chatState.transcript.history`
 * with them, exactly the way `chat-ui`'s own doc comment describes
 * (`history.seed` — "prefer for initial load / session replay") — no
 * `AcpLiveSession`, no wire connection, no worker process. This is the
 * whole point of the seam: a stored `TranscriptTurn[]` renders through the
 * same `ChatTranscript` a live session uses, entirely offline.
 *
 * Lives under the `browser` project (real Chromium, per this repo's own
 * convention for anything that imports `@emdash/chat-ui`) — chat-ui's
 * bundle touches `document` at module load (its markdown entity table),
 * which the `node` project's plain-Node environment doesn't have.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<RigStoredSession | null>>(),
  getEvents: vi.fn<() => Promise<RigSessionEventRecord[]>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      sessions: {
        getSession: () => mocks.getSession(),
        getEvents: () => mocks.getEvents(),
      },
    },
  },
}));

const { ReplayStore } = await import('../../features/chat/replay-store');

function storedSession(overrides: Partial<RigStoredSession> = {}): RigStoredSession {
  return {
    id: 'session-1',
    rigId: 'rig-1',
    providerId: 'claude',
    title: 'Fix the flaky test',
    titleSource: 'auto',
    status: 'closed',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    acpSessionId: 'acp-abc',
    ...overrides,
  };
}

function eventRecord(seq: number, at: number): RigSessionEventRecord {
  return {
    seq,
    at,
    turn: {
      id: `turn-${seq}`,
      seq,
      initiator: 'user',
      items: [{ kind: 'message', id: `msg-${seq}`, seq: 0, role: 'user', text: `prompt ${seq}` }],
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ReplayStore.load', () => {
  it('seeds the transcript with the stored turns, stamped with their real at', async () => {
    mocks.getSession.mockResolvedValue(storedSession());
    mocks.getEvents.mockResolvedValue([eventRecord(0, 111), eventRecord(1, 222)]);

    const store = new ReplayStore('session-1');
    await store.load();

    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
    expect(store.session?.title).toBe('Fix the flaky test');

    const turns = store.chatState.transcript.history.get();
    expect(turns.map((t) => t.seq)).toEqual([0, 1]);
    const firstMessage = turns[0].items[0] as { at?: number };
    const secondMessage = turns[1].items[0] as { at?: number };
    expect(firstMessage.at).toBe(111);
    expect(secondMessage.at).toBe(222);

    store.dispose();
  });

  it('drops a stored event whose JSON no longer matches the turn schema, keeping the rest', async () => {
    mocks.getSession.mockResolvedValue(storedSession());
    mocks.getEvents.mockResolvedValue([
      eventRecord(0, 111),
      { seq: 1, at: 222, turn: { not: 'a turn' } },
    ]);

    const store = new ReplayStore('session-1');
    await store.load();

    expect(store.chatState.transcript.history.get().map((t) => t.seq)).toEqual([0]);
    store.dispose();
  });

  it('fails honestly when the session row is gone', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getEvents.mockResolvedValue([]);

    const store = new ReplayStore('session-1');
    await store.load();

    expect(store.loading).toBe(false);
    expect(store.error).toBeTruthy();
    expect(store.chatState.transcript.history.get()).toEqual([]);
    store.dispose();
  });
});
