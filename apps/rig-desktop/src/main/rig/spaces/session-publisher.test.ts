import { err, ok } from '@emdash/shared';
import { describe, expect, it } from 'vitest';
import type { RelayApiError, SessionEventInput, SpacesRelayApi } from './relay-api';
import { connectorsHiddenContext, spacesHiddenContext } from './dispatch';
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
    mintRealtimeTicket: async () => err<RelayApiError>({ kind: 'relay', message: 'unused' }),
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

  it('finish() while a batch is mid-send still sends the tail, turn_ended included', async () => {
    // The relay answers the first batch only when we say so, so finish()
    // lands while that send is in flight: the race that used to drop the
    // run's last events and leave every card spinning.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const sent: SessionEventInput[][] = [];
    const { api, patches } = fakeApi({
      postSessionEvents: async (_b, _r, events) => {
        if (first) {
          first = false;
          await gate;
        }
        sent.push(events);
        return ok({ inserted: events.length, upToSeq: events[events.length - 1]?.seq ?? null });
      },
    });
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

    pub.record('agent_message_chunk', { text: 'a' });
    pub.record('agent_message_chunk', { text: 'b' }); // full batch: flush starts, blocked on the gate
    void clock.advance(0);
    pub.record('agent_message_chunk', { text: 'c' });
    pub.record('turn_ended', { status: 'done' });
    const finished = pub.finish('done');
    release();
    await finished;

    expect(sent.flat().map((e) => e.kind)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'turn_ended',
    ]);
    expect(pub.pending).toBe(0);
    expect(patches).toEqual([{ status: 'done' }]);
  });

  it("finish() waits for a retrying tail but gives up once maxRetryMs elapses, still patching the terminal status", async () => {
    // The relay never comes back (a transport failure every time), so the
    // tail keeps retrying. finish() must not hang forever — it drains up to
    // `maxRetryMs` of backoff, then drops the tail and patches status anyway.
    const { api, calls, patches } = fakeApi({
      postSessionEvents: async () => err<RelayApiError>({ kind: 'relay', message: 'relay unreachable' }),
    });
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      maxBatchSize: 1,
      flushIntervalMs: 10,
      maxRetryMs: 50,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0,
    });

    pub.record('agent_message_chunk', { text: 'x' });
    const finished = pub.finish('failed');
    // Advance in small steps (not one huge jump) so `now()` reflects a
    // realistic, gradually-advancing clock at each retry — same as real
    // wall time would. 50 steps of 5ms comfortably clears `maxRetryMs=50`.
    for (let i = 0; i < 50; i += 1) await clock.advance(5);
    await finished;

    expect(calls).toHaveLength(0); // never got through
    expect(pub.pending).toBe(0); // the still-unsent tail was dropped, not left queued forever
    expect(patches).toEqual([{ status: 'failed' }]); // status patch still attempted
  });

  it('retries a batch that failed with 429, without losing or reordering its events', async () => {
    const sent: SessionEventInput[][] = [];
    let calls = 0;
    const { api } = fakeApi({
      postSessionEvents: async (_bindingId, _runId, events) => {
        calls += 1;
        if (calls === 1) return err<RelayApiError>({ kind: 'relay', status: 429, message: 'rate_limited' });
        sent.push(events);
        return ok({ inserted: events.length, upToSeq: events[events.length - 1]?.seq ?? null });
      },
    });
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
      random: () => 0, // deterministic backoff: base/2 exactly
    });

    pub.record('tool_call', { a: 1 });
    pub.record('tool_call', { a: 2 }); // crosses maxBatchSize -> immediate flush, which 429s
    await clock.advance(0);
    expect(sent).toHaveLength(0);
    expect(pub.pending).toBe(2);

    await clock.advance(125); // backoff for attempt 1: base=250 (flushIntervalMs), jitter(0)=125
    expect(sent).toHaveLength(1);
    expect(sent[0].map((e) => e.payload)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(pub.pending).toBe(0);
  });

  it('honors Retry-After on a 429 instead of computing its own backoff', async () => {
    const sent: SessionEventInput[][] = [];
    let calls = 0;
    const { api } = fakeApi({
      postSessionEvents: async (_bindingId, _runId, events) => {
        calls += 1;
        if (calls === 1) {
          return err<RelayApiError>({ kind: 'relay', status: 429, message: 'rate_limited', retryAfterMs: 5000 });
        }
        sent.push(events);
        return ok({ inserted: events.length, upToSeq: events[events.length - 1]?.seq ?? null });
      },
    });
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
    pub.record('tool_call', { a: 2 });
    await clock.advance(0);
    expect(sent).toHaveLength(0);

    await clock.advance(4999);
    expect(sent).toHaveLength(0); // Retry-After (5000ms) hasn't elapsed yet
    await clock.advance(1);
    expect(sent).toHaveLength(1); // now it retries, exactly on the relay's own schedule
  });

  it('drops a batch rejected with a non-retryable 4xx instead of retrying it', async () => {
    const sent: SessionEventInput[][] = [];
    const { api } = fakeApi({
      postSessionEvents: async (_bindingId, _runId, events) => {
        sent.push(events);
        return err<RelayApiError>({ kind: 'relay', status: 400, message: 'bad batch' });
      },
    });
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
    pub.record('tool_call', { a: 2 });
    await clock.advance(0);

    expect(sent).toHaveLength(1); // tried exactly once
    expect(pub.pending).toBe(0); // dropped, not kept around for a retry
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

describe('SessionEventPublisher: hidden context never leaves in an echo', () => {
  const visible = 'Which launch tasks are still open?';
  // Built exactly as `startTurn` builds it: the space context (room transcript
  // included), the connectors note, and a doc thread with no rig tag.
  const hidden = [
    spacesHiddenContext({ bindingId: 'b1' }, ['Sam: the acquisition closes on the 14th, keep it quiet']),
    connectorsHiddenContext(['linear'], []),
    'The thread so far, oldest first:\n- Priya: salary bands are in comp.md',
  ].join('\n\n');
  const secrets = ['rig_space_context', 'acquisition closes', 'rig_connectors', 'salary bands', 'room_messages'];

  function publisher(prompt = visible) {
    const { api, calls } = fakeApi();
    const clock = fakeClock();
    const pub = new SessionEventPublisher({
      api,
      bindingId: 'b1',
      runId: 'run1',
      prompt,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const sent = () => calls.flat();
    return { pub, sent };
  }

  function expectNoSecrets(value: unknown) {
    const json = JSON.stringify(value);
    for (const secret of secrets) expect(json).not.toContain(secret);
  }

  it("publishes Codex's session title as the visible prompt, not the prompt+hidden block it echoes", async () => {
    const { pub, sent } = publisher();
    pub.setHiddenContext(hidden);
    // codex-acp: the text blocks joined with ' ', whitespace collapsed.
    const echoed = { sessionUpdate: 'session_info_update', title: `${visible} ${hidden}`.replace(/\s+/g, ' ') };
    pub.record('session_info_update', echoed);
    await pub.flush();

    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.payload).toEqual({ sessionUpdate: 'session_info_update', title: visible });
    expectNoSecrets(sent());
    expect(echoed.title).toContain('acquisition closes'); // the local copy is untouched
  });

  it('clips a long visible prompt to the run-title length, and leaves title-less info updates alone', async () => {
    const { pub, sent } = publisher(`Please ${'really '.repeat(30)}check the plan`);
    pub.setHiddenContext(hidden);
    pub.record('session_info_update', { sessionUpdate: 'session_info_update', title: 'Launch tasks review' });
    const status = { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'idle' } } } };
    pub.record('session_info_update', status);
    await pub.flush();

    const title = sent()[0]?.payload.title as string;
    expect(title.length).toBe(80);
    expect(title.startsWith('Please really')).toBe(true);
    expect(sent()[1]?.payload).toEqual(status);
  });

  it("strips a Claude-style prompt echo: the hidden block's own chunk is dropped, the visible text kept", async () => {
    const { pub, sent } = publisher();
    pub.setHiddenContext(hidden);
    // The prompt goes out as two text blocks; an echo replays each as a chunk.
    pub.record('user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: visible } });
    pub.record('user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: hidden } });
    // …or as one text with both.
    pub.record('user_message_chunk', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `${visible}\n${hidden}` },
    });
    // Claude's generated title is written from mostly-hidden text: replaced too.
    pub.record('session_info_update', { sessionUpdate: 'session_info_update', title: 'Quiet acquisition timeline' });
    await pub.flush();

    expect(sent().map((e) => [e.kind, e.payload])).toEqual([
      ['user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: visible } }],
      ['user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: visible } }],
      ['session_info_update', { sessionUpdate: 'session_info_update', title: visible }],
    ]);
    expect(sent().map((e) => e.seq)).toEqual([1, 2, 3]); // a dropped echo leaves no seq gap
    expectNoSecrets(sent());
  });

  it('strips any <rig_…> block from an echo even without the exact hidden context (another turn, truncated)', async () => {
    const { pub, sent } = publisher();
    // No setHiddenContext: e.g. an earlier turn's prompt replayed.
    pub.record('user_message_chunk', {
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: 'hi <rig_space_context>\n<room_messages>\nSam: the acquisition closes on the 14th\n</room_messages>\n</rig_space_context> there <rig_context_target version="1">x</rig_context_target>',
      },
    });
    // Truncated mid-block: no closing tag, so the rest of the text goes.
    pub.record('user_message_chunk', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'ask the room <rig_connectors>\nConnected tools: Linear. The acquisition closes' },
    });
    await pub.flush();

    const texts = sent().map((e) => (e.payload.content as { text: string }).text);
    expect(texts[0]).toMatch(/^hi\s+there$/);
    expect(texts[1]).toBe('ask the room');
    expectNoSecrets(sent());
  });

  it("leaves other events verbatim (tool titles and inputs aren't prompt echoes)", async () => {
    const { pub, sent } = publisher();
    pub.setHiddenContext(hidden);
    const tool = { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep -r "<rig_space_context>" src', rawInput: { q: 1 } };
    pub.record('tool_call', tool);
    await pub.flush();
    expect(sent()[0]?.payload).toEqual(tool);
  });
});
