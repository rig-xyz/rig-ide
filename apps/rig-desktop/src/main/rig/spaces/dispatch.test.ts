import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeviceIdResolver,
  createSpacesDispatcher,
  type BusyChange,
  type RawSessionEvent,
  type SpacesAcpSessions,
} from './dispatch';
import type {
  AgentRequest,
  RelayApiError,
  SessionRun,
  SessionStatus,
  SpacesRelayApi,
} from './relay-api';

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id: 'req1',
    bindingId: 'binding-1',
    targetOwnerUserId: 'owner-1',
    targetAgent: 'claude',
    requestedByUserId: 'other',
    sourceMessageId: null,
    prompt: 'do the thing',
    status: 'queued',
    claimedByDeviceId: null,
    claimedAt: null,
    runId: null,
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:00:00Z',
    ...overrides,
  };
}

function notImplemented(name: string) {
  return async () => {
    throw new Error(`${name} should not be called in this test`);
  };
}

/** A working fake `SpacesRelayApi` with call logs, enough for `SessionEventPublisher`/`markRequestSettled` to run for real against it. */
function makeFakeApi(overrides: Partial<SpacesRelayApi> = {}) {
  let nextRunId = 1;
  const createdRuns: Array<{ bindingId: string; agent: string }> = [];
  const patchedSessions: Array<{ runId: string; status?: SessionStatus }> = [];
  const postedEvents: Array<{ runId: string; kinds: string[] }> = [];
  const patchedRequests: Array<{ id: string; status: string }> = [];
  const mintedDevices: string[] = [];

  const api: SpacesRelayApi = {
    whoami: async () => ok({ id: 'owner-1' }),
    async createSession(bindingId, input) {
      const id = `run-${nextRunId++}`;
      createdRuns.push({ bindingId, agent: input.agent });
      const run: SessionRun = {
        id,
        bindingId,
        ownerUserId: 'owner-1',
        agent: input.agent,
        model: null,
        status: 'running',
        title: input.title ?? null,
        commands: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      return ok(run);
    },
    async patchSession(bindingId, runId, patch) {
      patchedSessions.push({ runId, status: patch.status });
      const run: SessionRun = {
        id: runId,
        bindingId,
        ownerUserId: 'owner-1',
        agent: 'claude',
        model: null,
        status: patch.status ?? 'running',
        title: patch.title ?? null,
        commands: null,
        startedAt: new Date().toISOString(),
        endedAt: patch.status && patch.status !== 'running' ? new Date().toISOString() : null,
      };
      return ok(run);
    },
    async postSessionEvents(_bindingId, runId, events) {
      postedEvents.push({ runId, kinds: events.map((e) => e.kind) });
      return ok({ inserted: events.length, upToSeq: events.at(-1)?.seq ?? null });
    },
    getSessionEvents: notImplemented('getSessionEvents'),
    createAgentRequest: notImplemented('createAgentRequest'),
    async mintDevice(bindingId) {
      const id = `device-for-${bindingId}`;
      mintedDevices.push(bindingId);
      return ok({ id, bindingId });
    },
    listAgentRequests: notImplemented('listAgentRequests'),
    claimAgentRequest: notImplemented('claimAgentRequest'),
    async patchAgentRequest(_bindingId, id, patch) {
      patchedRequests.push({ id, status: patch.status });
      return ok({ ...makeRequest({ id }), status: patch.status, runId: patch.runId ?? null });
    },
    listMembers: notImplemented('listMembers'),
    listMessages: notImplemented('listMessages'),
    postMessage: notImplemented('postMessage'),
    ...overrides,
  };

  return { api, createdRuns, patchedSessions, postedEvents, patchedRequests, mintedDevices };
}

/** A fully controllable fake `SpacesAcpSessions` — the seam this module is built to be tested against. */
function makeFakeAcp() {
  const rawHandlers = new Map<string, (raw: RawSessionEvent) => void>();
  const busyHandlers = new Map<string, (change: BusyChange) => void>();
  const started: Array<{ conversationId: string; providerId: string; cwd: string }> = [];
  const queued: Array<{ conversationId: string; text: string }> = [];
  const cancelled: string[] = [];
  const callOrder: string[] = [];

  let startResult: Result<void, string> = ok(undefined);
  let queueResult: Result<void, string> = ok(undefined);

  const acp: SpacesAcpSessions = {
    async startSession(input) {
      callOrder.push(`startSession:${input.conversationId}`);
      started.push(input);
      return startResult;
    },
    async queuePrompt(conversationId, text) {
      callOrder.push(`queuePrompt:${conversationId}`);
      queued.push({ conversationId, text });
      return queueResult;
    },
    async cancelTurn(conversationId) {
      cancelled.push(conversationId);
    },
    async subscribeRaw(conversationId, onEvent) {
      callOrder.push(`subscribeRaw:${conversationId}`);
      rawHandlers.set(conversationId, onEvent);
      return () => rawHandlers.delete(conversationId);
    },
    async subscribeBusy(conversationId, onChange) {
      callOrder.push(`subscribeBusy:${conversationId}`);
      busyHandlers.set(conversationId, onChange);
      // Mirrors the real ReplicaState: fires once immediately with the seed (idle) value.
      onChange({ isGenerating: false, lastStopReason: null });
      return () => busyHandlers.delete(conversationId);
    },
  };

  return {
    acp,
    started,
    queued,
    cancelled,
    callOrder,
    setStartResult: (r: Result<void, string>) => (startResult = r),
    setQueueResult: (r: Result<void, string>) => (queueResult = r),
    emitRaw: (conversationId: string, update: RawSessionEvent['update']) =>
      rawHandlers.get(conversationId)?.({ sessionId: 'acp-session-1', update }),
    emitBusy: (conversationId: string, change: BusyChange) =>
      busyHandlers.get(conversationId)?.(change),
  };
}

describe('createSpacesDispatcher', () => {
  it('starts a fresh persistent session, subscribing to raw/busy events before starting it', async () => {
    const { api, createdRuns, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest());

    expect(result).toEqual({ runId: 'run-1' });
    expect(createdRuns).toEqual([{ bindingId: 'binding-1', agent: 'claude' }]);
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]).toMatchObject({ providerId: 'claude', cwd: '/rigs/one' });
    expect(fake.queued).toEqual([{ conversationId: fake.started[0].conversationId, text: 'do the thing' }]);
    // Subscriptions happen before the session starts.
    const conversationId = fake.started[0].conversationId;
    expect(fake.callOrder.indexOf(`subscribeRaw:${conversationId}`)).toBeLessThan(
      fake.callOrder.indexOf(`startSession:${conversationId}`)
    );
    expect(fake.callOrder.indexOf(`subscribeBusy:${conversationId}`)).toBeLessThan(
      fake.callOrder.indexOf(`startSession:${conversationId}`)
    );
    // Nothing settled yet — the turn hasn't even started.
    expect(patchedRequests).toEqual([]);
  });

  it('reuses the same persistent session for a second request to the same space/owner/agent', async () => {
    const { api } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    await dispatch(makeRequest({ id: 'req1', prompt: 'first' }));
    await dispatch(makeRequest({ id: 'req2', prompt: 'second' }));

    expect(fake.started).toHaveLength(1); // only ONE local session ever started
    expect(fake.queued.map((q) => q.text)).toEqual(['first', 'second']);
    expect(new Set(fake.queued.map((q) => q.conversationId)).size).toBe(1); // same conversation both times
  });

  it('starts a SEPARATE persistent session for a different target agent in the same space', async () => {
    const { api } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    await dispatch(makeRequest({ id: 'req1', targetAgent: 'claude' }));
    await dispatch(makeRequest({ id: 'req2', targetAgent: 'codex' }));

    expect(fake.started).toHaveLength(2);
    expect(new Set(fake.started.map((s) => s.conversationId)).size).toBe(2);
  });

  it('forwards raw events to the run in progress, dropping available_commands_update', async () => {
    const { api, postedEvents } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest());
    if ('failed' in result) throw new Error('expected success');
    const conversationId = fake.started[0].conversationId;

    fake.emitBusy(conversationId, { isGenerating: true, lastStopReason: null });
    fake.emitRaw(conversationId, { sessionUpdate: 'available_commands_update', commands: [] });
    fake.emitRaw(conversationId, { sessionUpdate: 'tool_call', toolCallId: 't1' });
    fake.emitBusy(conversationId, { isGenerating: false, lastStopReason: 'end_turn' });
    await vi.waitFor(() => expect(postedEvents.length).toBeGreaterThan(0));

    const kinds = postedEvents.flatMap((p) => p.kinds);
    expect(kinds).toEqual(['tool_call']);
  });

  it('finishes the run "done" and the request "done" on a normal end_turn', async () => {
    const { api, patchedSessions, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest({ id: 'req1' }));
    if ('failed' in result) throw new Error('expected success');
    const conversationId = fake.started[0].conversationId;
    fake.emitBusy(conversationId, { isGenerating: true, lastStopReason: null });
    fake.emitBusy(conversationId, { isGenerating: false, lastStopReason: 'end_turn' });

    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'done' }]));
    expect(patchedSessions).toEqual([{ runId: result.runId, status: 'done' }]);
  });

  it('maps an in-turn error (lastStopReason: null on a busy->idle edge) to failed/failed', async () => {
    const { api, patchedSessions, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest({ id: 'req1' }));
    if ('failed' in result) throw new Error('expected success');
    const conversationId = fake.started[0].conversationId;
    fake.emitBusy(conversationId, { isGenerating: true, lastStopReason: null });
    fake.emitBusy(conversationId, { isGenerating: false, lastStopReason: null });

    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'failed' }]));
    expect(patchedSessions).toEqual([{ runId: result.runId, status: 'failed' }]);
  });

  it('correlates raw events and turn-end to the right request, FIFO, across two queued turns', async () => {
    const { api, postedEvents, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const a = await dispatch(makeRequest({ id: 'reqA' }));
    const b = await dispatch(makeRequest({ id: 'reqB' }));
    if ('failed' in a || 'failed' in b) throw new Error('expected success');
    const conversationId = fake.started[0].conversationId;

    fake.emitBusy(conversationId, { isGenerating: true, lastStopReason: null });
    fake.emitRaw(conversationId, { sessionUpdate: 'tool_call', toolCallId: 'for-a' });
    fake.emitBusy(conversationId, { isGenerating: false, lastStopReason: 'end_turn' });
    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'reqA', status: 'done' }]));

    fake.emitBusy(conversationId, { isGenerating: true, lastStopReason: null });
    fake.emitRaw(conversationId, { sessionUpdate: 'tool_call', toolCallId: 'for-b' });
    fake.emitBusy(conversationId, { isGenerating: false, lastStopReason: 'cancelled' });
    await vi.waitFor(() =>
      expect(patchedRequests).toEqual([
        { id: 'reqA', status: 'done' },
        { id: 'reqB', status: 'cancelled' },
      ])
    );

    const aEvents = postedEvents.find((p) => p.runId === a.runId);
    const bEvents = postedEvents.find((p) => p.runId === b.runId);
    expect(aEvents?.kinds).toEqual(['tool_call']);
    expect(bEvents?.kinds).toEqual(['tool_call']);
  });

  it('stopRun on the CURRENTLY RUNNING turn cancels it and finalizes it "stopped" once the runtime confirms', async () => {
    const { api, patchedSessions, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch, stopRun } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest({ id: 'req1' }));
    if ('failed' in result) throw new Error('expected success');
    const conversationId = fake.started[0].conversationId;
    fake.emitBusy(conversationId, { isGenerating: true, lastStopReason: null });

    const stopped = await stopRun(result.runId);
    expect(stopped).toBe(true);
    expect(fake.cancelled).toEqual([conversationId]);

    // The runtime settles the cancel asynchronously — until it does, nothing is finalized yet.
    expect(patchedRequests).toEqual([]);
    fake.emitBusy(conversationId, { isGenerating: false, lastStopReason: 'cancelled' });
    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'cancelled' }]));
    expect(patchedSessions).toEqual([{ runId: result.runId, status: 'stopped' }]);
  });

  it('stopRun on a PENDING (not yet started) turn removes and finalizes it immediately, without cancelling anything', async () => {
    const { api, patchedSessions, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch, stopRun } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const a = await dispatch(makeRequest({ id: 'reqA' }));
    const b = await dispatch(makeRequest({ id: 'reqB' }));
    if ('failed' in a || 'failed' in b) throw new Error('expected success');

    const stopped = await stopRun(b.runId);
    expect(stopped).toBe(true);
    expect(fake.cancelled).toEqual([]); // never started — nothing to cancel

    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'reqB', status: 'cancelled' }]));
    expect(patchedSessions).toEqual([{ runId: b.runId, status: 'stopped' }]);
  });

  it('stopRun returns false for a run this device never dispatched', async () => {
    const { api } = makeFakeApi();
    const fake = makeFakeAcp();
    const { stopRun } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });
    expect(await stopRun('someone-elses-run')).toBe(false);
  });

  it('fails without starting anything when no local workspace is bound to the request', async () => {
    const { api, createdRuns } = makeFakeApi();
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => null,
    });

    const result = await dispatch(makeRequest());
    expect(result).toMatchObject({ failed: true });
    expect(createdRuns).toEqual([]);
    expect(fake.started).toEqual([]);
  });

  it('fails, and leaves nothing registered, when starting the local session fails', async () => {
    const { api } = makeFakeApi();
    const fake = makeFakeAcp();
    fake.setStartResult(err('boom'));
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const first = await dispatch(makeRequest({ id: 'req1' }));
    expect(first).toMatchObject({ failed: true });

    // A retry (e.g. a later request to the same key) is not stuck behind a half-registered session.
    fake.setStartResult(ok(undefined));
    const second = await dispatch(makeRequest({ id: 'req2' }));
    expect(second).toEqual({ runId: expect.any(String) });
  });

  it('fails and settles the request when queuePrompt itself fails', async () => {
    const { api, patchedSessions, patchedRequests } = makeFakeApi();
    const fake = makeFakeAcp();
    fake.setQueueResult(err('queue rejected'));
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest({ id: 'req1' }));
    expect(result).toMatchObject({ failed: true });
    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'failed' }]));
    expect(patchedSessions[0]).toMatchObject({ status: 'failed' });
  });

  it('fails cleanly when the relay refuses to create the session run', async () => {
    const { api } = makeFakeApi({
      createSession: async () => err<RelayApiError>({ kind: 'relay', message: 'relay down' }),
    });
    const fake = makeFakeAcp();
    const { dispatch } = createSpacesDispatcher({
      api,
      acp: fake.acp,
      resolveWorkspace: async () => '/rigs/one',
    });

    const result = await dispatch(makeRequest());
    expect(result).toMatchObject({ failed: true });
    expect(fake.queued).toEqual([]); // never even tried to prompt
  });
});

describe('createDeviceIdResolver', () => {
  it('mints once per binding and memoizes the result', async () => {
    const { api, mintedDevices } = makeFakeApi();
    const resolve = createDeviceIdResolver(api);

    expect(await resolve('binding-a')).toBe('device-for-binding-a');
    expect(await resolve('binding-a')).toBe('device-for-binding-a');
    expect(await resolve('binding-b')).toBe('device-for-binding-b');
    expect(mintedDevices).toEqual(['binding-a', 'binding-b']);
  });

  it('dedupes overlapping concurrent mints for the same binding into one call', async () => {
    let resolveMint!: (value: Result<{ id: string; bindingId: string }, RelayApiError>) => void;
    const mintDevice = vi.fn(
      () =>
        new Promise<Result<{ id: string; bindingId: string }, RelayApiError>>((resolve) => {
          resolveMint = resolve;
        })
    );
    const { api } = makeFakeApi({ mintDevice });
    const resolveDevice = createDeviceIdResolver(api);

    const p1 = resolveDevice('binding-a');
    const p2 = resolveDevice('binding-a');
    expect(mintDevice).toHaveBeenCalledTimes(1);
    resolveMint(ok({ id: 'device-1', bindingId: 'binding-a' }));

    expect(await p1).toBe('device-1');
    expect(await p2).toBe('device-1');
  });

  it('propagates a mint failure without caching it', async () => {
    let shouldFail = true;
    const { api } = makeFakeApi({
      mintDevice: async (bindingId) =>
        shouldFail
          ? err<RelayApiError>({ kind: 'relay', message: 'mint failed' })
          : ok({ id: `device-for-${bindingId}`, bindingId }),
    });
    const resolveDevice = createDeviceIdResolver(api);

    await expect(resolveDevice('binding-a')).rejects.toThrow('mint failed');
    shouldFail = false;
    expect(await resolveDevice('binding-a')).toBe('device-for-binding-a');
  });
});
