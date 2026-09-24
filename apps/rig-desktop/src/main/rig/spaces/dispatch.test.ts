import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeviceIdResolver,
  createSpacesDispatcher,
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

function makePermissionRequest(overrides: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
  return {
    requestId: 'perm-1',
    toolCall: {
      id: 't1',
      seq: 1,
      toolCallId: 't1',
      title: 'Run rm -rf /',
      status: 'running',
      kind: 'execute-tool-call',
    } as AcpPermissionRequest['toolCall'],
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    ...overrides,
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
    mintRealtimeTicket: notImplemented('mintRealtimeTicket'),
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
  const permissionHandlers = new Map<string, (request: AcpPermissionRequest) => void>();
  const started: Array<{ conversationId: string; providerId: string; cwd: string }> = [];
  const queued: Array<{ conversationId: string; text: string; turnId: string }> = [];
  const cancelled: string[] = [];
  const resolvedPermissions: Array<{ conversationId: string; requestId: string; optionId: string }> = [];
  const callOrder: string[] = [];

  let startResult: Result<void, string> = ok(undefined);
  let turnCounter = 0;
  /** When set, overrides the default (immediate, auto-incrementing turnId) `queuePrompt` behaviour. */
  let queuePromptImpl: ((conversationId: string, text: string) => Promise<Result<{ turnId: string }, string>>) | null =
    null;

  const acp: SpacesAcpSessions = {
    async startSession(input) {
      callOrder.push(`startSession:${input.conversationId}`);
      started.push(input);
      return startResult;
    },
    async queuePrompt(conversationId, text) {
      callOrder.push(`queuePrompt:${conversationId}`);
      if (queuePromptImpl) return queuePromptImpl(conversationId, text);
      const turnId = `turn-${++turnCounter}`;
      queued.push({ conversationId, text, turnId });
      return ok({ turnId });
    },
    async cancelTurn(conversationId) {
      cancelled.push(conversationId);
    },
    async subscribeRaw(conversationId, onEvent) {
      callOrder.push(`subscribeRaw:${conversationId}`);
      rawHandlers.set(conversationId, onEvent);
      return () => rawHandlers.delete(conversationId);
    },
    async subscribePendingPermissions(conversationId, onRequest) {
      callOrder.push(`subscribePendingPermissions:${conversationId}`);
      permissionHandlers.set(conversationId, onRequest);
      return () => permissionHandlers.delete(conversationId);
    },
    async resolvePermission(conversationId, requestId, optionId) {
      resolvedPermissions.push({ conversationId, requestId, optionId });
    },
  };

  return {
    acp,
    started,
    queued,
    cancelled,
    resolvedPermissions,
    callOrder,
    setStartResult: (r: Result<void, string>) => (startResult = r),
    /** Replaces `queuePrompt`'s default immediate-resolve behaviour, e.g. to control exactly when it resolves relative to raw-stream markers. */
    setQueuePromptImpl: (
      impl: (conversationId: string, text: string) => Promise<Result<{ turnId: string }, string>>
    ) => (queuePromptImpl = impl),
    emitTurnStart: (conversationId: string, turnId: string) =>
      rawHandlers.get(conversationId)?.({ kind: 'turn_start', turnId }),
    emitTurnEnd: (conversationId: string, turnId: string, stopReason: string | null) =>
      rawHandlers.get(conversationId)?.({ kind: 'turn_end', turnId, stopReason }),
    emitUpdate: (conversationId: string, update: { sessionUpdate: string } & Record<string, unknown>) =>
      rawHandlers.get(conversationId)?.({ kind: 'acp_update', sessionId: 'acp-session-1', update }),
    emitPermissionRequest: (conversationId: string, request: AcpPermissionRequest) =>
      permissionHandlers.get(conversationId)?.(request),
  };
}

describe('createSpacesDispatcher', () => {
  it('starts a fresh persistent session, subscribing to raw events/permissions before starting it', async () => {
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
    expect(fake.queued.map((q) => ({ conversationId: q.conversationId, text: q.text }))).toEqual([
      { conversationId: fake.started[0].conversationId, text: 'do the thing' },
    ]);
    // Subscriptions happen before the session starts.
    const conversationId = fake.started[0].conversationId;
    expect(fake.callOrder.indexOf(`subscribeRaw:${conversationId}`)).toBeLessThan(
      fake.callOrder.indexOf(`startSession:${conversationId}`)
    );
    expect(fake.callOrder.indexOf(`subscribePendingPermissions:${conversationId}`)).toBeLessThan(
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
    const turnId = fake.queued[0].turnId;

    fake.emitTurnStart(conversationId, turnId);
    fake.emitUpdate(conversationId, { sessionUpdate: 'available_commands_update', commands: [] });
    fake.emitUpdate(conversationId, { sessionUpdate: 'tool_call', toolCallId: 't1' });
    fake.emitTurnEnd(conversationId, turnId, 'end_turn');
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
    const turnId = fake.queued[0].turnId;
    fake.emitTurnStart(conversationId, turnId);
    fake.emitTurnEnd(conversationId, turnId, 'end_turn');

    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'done' }]));
    expect(patchedSessions).toEqual([{ runId: result.runId, status: 'done' }]);
  });

  it('maps an in-turn error (turn_end stopReason: null) to failed/failed', async () => {
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
    const turnId = fake.queued[0].turnId;
    fake.emitTurnStart(conversationId, turnId);
    fake.emitTurnEnd(conversationId, turnId, null);

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
    const [turnA, turnB] = fake.queued.map((q) => q.turnId);

    fake.emitTurnStart(conversationId, turnA);
    fake.emitUpdate(conversationId, { sessionUpdate: 'tool_call', toolCallId: 'for-a' });
    fake.emitTurnEnd(conversationId, turnA, 'end_turn');
    await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'reqA', status: 'done' }]));

    fake.emitTurnStart(conversationId, turnB);
    fake.emitUpdate(conversationId, { sessionUpdate: 'tool_call', toolCallId: 'for-b' });
    fake.emitTurnEnd(conversationId, turnB, 'cancelled');
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

  describe('in-band turn boundaries (review findings (a) and (b))', () => {
    it('(a) claims a turn_start that arrives before queuePrompt itself resolves, never dropping the events that follow it', async () => {
      // Reproduces the drop: `subscribeRaw` and the busy/idle signal used to
      // travel on separate channels with no ordering guarantee. Here we
      // simulate the worst case directly — the runtime's raw stream
      // delivers turn_start, an update, AND turn_end before the RPC call
      // that queued the prompt has even resolved back to this module.
      const { api, postedEvents, patchedRequests } = makeFakeApi();
      const fake = makeFakeAcp();
      let resolveQueue!: (r: Result<{ turnId: string }, string>) => void;
      fake.setQueuePromptImpl(
        () =>
          new Promise((resolve) => {
            resolveQueue = resolve;
          })
      );
      const { dispatch } = createSpacesDispatcher({
        api,
        acp: fake.acp,
        resolveWorkspace: async () => '/rigs/one',
      });

      const dispatchPromise = dispatch(makeRequest({ id: 'req1' }));
      await vi.waitFor(() => expect(fake.started).toHaveLength(1));
      const conversationId = fake.started[0].conversationId;

      // Raw stream races ahead of the queuePrompt RPC ack.
      fake.emitTurnStart(conversationId, 'server-turn-1');
      fake.emitUpdate(conversationId, { sessionUpdate: 'tool_call', toolCallId: 't1' });
      fake.emitTurnEnd(conversationId, 'server-turn-1', 'end_turn');

      // Only now does queuePrompt's own RPC ack arrive, carrying the SAME turnId.
      resolveQueue(ok({ turnId: 'server-turn-1' }));
      const result = await dispatchPromise;
      if ('failed' in result) throw new Error('expected success');

      await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'done' }]));
      const events = postedEvents.find((p) => p.runId === result.runId);
      expect(events?.kinds).toEqual(['tool_call']);
    });

    it('(b) never drops a turn\'s final event even when it arrives in the very same tick as turn_end', async () => {
      // Reproduces the other half of the drop: a busy/idle edge could
      // previously finalize (and finish the publisher for) a turn before
      // its own tail event — typically the final agent_message_chunk — had
      // been forwarded. On the single in-band stream there is no separate
      // edge to race: every event delivered before turn_end is guaranteed
      // recorded before the turn is finalized.
      const { api, postedEvents, patchedRequests } = makeFakeApi();
      const fake = makeFakeAcp();
      const { dispatch } = createSpacesDispatcher({
        api,
        acp: fake.acp,
        resolveWorkspace: async () => '/rigs/one',
      });

      const result = await dispatch(makeRequest({ id: 'req1' }));
      if ('failed' in result) throw new Error('expected success');
      const conversationId = fake.started[0].conversationId;
      const turnId = fake.queued[0].turnId;

      fake.emitTurnStart(conversationId, turnId);
      fake.emitUpdate(conversationId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'the final answer' },
      });
      // No await between the tail event and turn_end.
      fake.emitTurnEnd(conversationId, turnId, 'end_turn');

      await vi.waitFor(() => expect(patchedRequests).toEqual([{ id: 'req1', status: 'done' }]));
      const events = postedEvents.find((p) => p.runId === result.runId);
      expect(events?.kinds).toEqual(['agent_message_chunk']);
    });
  });

  describe('permission requests during a spaces turn', () => {
    it('auto-declines a pending permission request, picking a reject option, and never picking an allow option', async () => {
      const { api } = makeFakeApi();
      const fake = makeFakeAcp();
      const { dispatch } = createSpacesDispatcher({
        api,
        acp: fake.acp,
        resolveWorkspace: async () => '/rigs/one',
      });

      const result = await dispatch(makeRequest());
      if ('failed' in result) throw new Error('expected success');
      const conversationId = fake.started[0].conversationId;
      const turnId = fake.queued[0].turnId;
      fake.emitTurnStart(conversationId, turnId);

      fake.emitPermissionRequest(conversationId, makePermissionRequest());

      await vi.waitFor(() => expect(fake.resolvedPermissions).toHaveLength(1));
      expect(fake.resolvedPermissions[0]).toEqual({
        conversationId,
        requestId: 'perm-1',
        optionId: 'reject-once',
      });
    });

    it('falls back to reject_always, then to the first option, when reject_once is not offered', async () => {
      const { api } = makeFakeApi();
      const fake = makeFakeAcp();
      const { dispatch } = createSpacesDispatcher({
        api,
        acp: fake.acp,
        resolveWorkspace: async () => '/rigs/one',
      });
      const result = await dispatch(makeRequest());
      if ('failed' in result) throw new Error('expected success');
      const conversationId = fake.started[0].conversationId;

      fake.emitPermissionRequest(
        conversationId,
        makePermissionRequest({
          options: [
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
          ],
        })
      );
      await vi.waitFor(() => expect(fake.resolvedPermissions).toHaveLength(1));
      expect(fake.resolvedPermissions[0]).toMatchObject({ optionId: 'reject-always' });
    });

    it('records permission_requested/permission_decided events, carrying the tool title, in the run log', async () => {
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
      const turnId = fake.queued[0].turnId;
      fake.emitTurnStart(conversationId, turnId);
      fake.emitPermissionRequest(conversationId, makePermissionRequest());

      await vi.waitFor(() => {
        const kinds = postedEvents.flatMap((p) => p.kinds);
        expect(kinds).toEqual(['permission_requested', 'permission_decided']);
      });
    });
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
    const turnId = fake.queued[0].turnId;
    fake.emitTurnStart(conversationId, turnId);

    const stopped = await stopRun(result.runId);
    expect(stopped).toBe(true);
    expect(fake.cancelled).toEqual([conversationId]);

    // The runtime settles the cancel asynchronously — until it does, nothing is finalized yet.
    expect(patchedRequests).toEqual([]);
    fake.emitTurnEnd(conversationId, turnId, 'cancelled');
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
    fake.setQueuePromptImpl(async () => err('queue rejected'));
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
