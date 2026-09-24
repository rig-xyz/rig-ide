import { err, ok } from '@emdash/shared';
import { describe, expect, it } from 'vitest';
import type { RelayApiError, SessionEventInput, SpacesRelayApi } from './relay-api';
import { SessionEventPublisher } from './session-publisher';

/**
 * A hand-written fake `SpacesRelayApi` recording every `postSessionEvents`/
 * `patchSession` call it receives, with a controllable failure mode — the
 * "mock the relay HTTP" the task calls for.
 */
function fakeApi(overrides: Partial<SpacesRelayApi> = {}): {
  api: SpacesRelayApi;
  calls: SessionEventInput[][];
  patches: Array<{ status: string }>;
  failNext: (times: number) => void;
} {
  const calls: SessionEventInput[][] = [];
  const patches: Array<{ status: string }> = [];
  let failuresRemaining = 0;

  const api: SpacesRelayApi = {
    whoami: async () => ok({ id: 'u1' }),
    createSession: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    patchSession: async (_bindingId, _runId, patch) => {
      patches.push({ status: String(patch.status) });
      return ok({
        id: 'run1',
        bindingId: 'b1',
        ownerUserId: 'u1',
        agent: 'claude',
        model: null,
        status: (patch.status as never) ?? 'running',
        title: null,
        commands: null,
        startedAt: '',
        endedAt: null,
      });
    },
    postSessionEvents: async (_bindingId, _runId, events) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return err<RelayApiError>({ kind: 'relay', message: 'relay unreachable' });
      }
      calls.push(events);
      return ok({ inserted: events.length, upToSeq: events[events.length - 1]?.seq ?? null });
    },
    getSessionEvents: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    createAgentRequest: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    mintDevice: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    listAgentRequests: async () => ok([]),
    claimAgentRequest: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    patchAgentRequest: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    listMembers: async () => ok([]),
    listMessages: async () => ok([]),
    postMessage: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
    ...overrides,
  };

  return {
    api,
    calls,
    patches,
    failNext: (times: number) => {
      failuresRemaining = times;
    },
  };
}

/** A manually-advanceable fake clock/timer, so batching cadence tests don't depend on real wall time. */
function fakeClock() {
  let now = 0;
  const pending: Array<{ at: number; cb: () => void; handle: number }> = [];
  let nextHandle = 1;
  return {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.push({ at: now + ms, cb, handle });
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      const idx = pending.findIndex((p) => p.handle === handle);
      if (idx !== -1) pending.splice(idx, 1);
    },
    /** Advances time and synchronously fires every timer whose deadline has passed, in order. */
    advance: async (ms: number) => {
      now += ms;
      for (;;) {
        const due = pending
          .filter((p) => p.at <= now)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        const idx = pending.indexOf(due);
        pending.splice(idx, 1);
        due.cb();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe('SessionEventPublisher', () => {
  it('flushes immediately once the batch reaches maxBatchSize, without waiting for the timer', async () => {
    const { api, calls } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 3,
      flushIntervalMs: 250,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    pub.record('tool_call', { a: 1 });
    pub.record('tool_call', { a: 2 });
    expect(calls).toHaveLength(0); // below threshold — nothing sent yet
    pub.record('tool_call', { a: 3 }); // crosses maxBatchSize=3

    await clock.advance(0); // let the zero-delay flush timer fire
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(pub.pending).toBe(0);
  });

  it('flushes on the 250ms timer when the batch never reaches maxBatchSize', async () => {
    const { api, calls } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 32,
      flushIntervalMs: 250,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    pub.record('agent_message_chunk', { text: 'hi' });
    expect(calls).toHaveLength(0);
    await clock.advance(249);
    expect(calls).toHaveLength(0);
    await clock.advance(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it('assigns monotonically increasing seq across multiple flushes', async () => {
    const { api, calls } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 2,
      flushIntervalMs: 250,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    for (let i = 0; i < 5; i += 1) pub.record('tool_call_update', { i });
    // 5 events, batches of 2: two immediate flushes (4 events), one queued.
    await clock.advance(0);
    await clock.advance(250);

    const allEvents = calls.flat();
    const seqs = allEvents.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seqs).size).toBe(5); // no duplicates
  });

  it('retries a failed batch and does not drop or reorder its events', async () => {
    const { api, calls, failNext } = fakeApi();
    failNext(1); // the first postSessionEvents call fails
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 2,
      flushIntervalMs: 250,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    pub.record('tool_call', { a: 1 });
    pub.record('tool_call', { a: 2 }); // crosses maxBatchSize -> immediate flush, which fails
    await clock.advance(0);
    expect(calls).toHaveLength(0); // failed attempt recorded nothing
    expect(pub.pending).toBe(2); // still queued for retry

    await clock.advance(250); // retry timer
    expect(calls).toHaveLength(1);
    expect(calls[0].map((e) => e.payload)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(pub.pending).toBe(0);
  });

  it('drops the oldest event once the retry queue exceeds maxQueueSize', () => {
    const { api } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 1000, // never auto-flush in this test
      flushIntervalMs: 999_999,
      maxQueueSize: 3,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    pub.record('a', { i: 1 });
    pub.record('a', { i: 2 });
    pub.record('a', { i: 3 });
    pub.record('a', { i: 4 }); // queue was full (3) — drops the oldest (i:1) first

    expect(pub.pending).toBe(3);
  });

  it('finish() flushes remaining events then patches the terminal status', async () => {
    const { api, calls, patches } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 32,
      flushIntervalMs: 250,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    pub.record('agent_message_chunk', { text: 'done' });
    await pub.finish('done');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(patches).toEqual([{ status: 'done' }]);
  });

  it('finish() patches status even when the tail never sent (relay unreachable)', async () => {
    const { api, calls, patches, failNext } = fakeApi();
    failNext(10);
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 32,
      flushIntervalMs: 250,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    pub.record('agent_message_chunk', { text: 'x' });
    await pub.finish('failed');

    expect(calls).toHaveLength(0); // never got through
    expect(patches).toEqual([{ status: 'failed' }]); // status patch still attempted
  });

  it('record() never throws even after dispose()', () => {
    const { api } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    pub.dispose();
    expect(() => pub.record('tool_call', {})).not.toThrow();
    expect(pub.pending).toBe(0);
  });
});
