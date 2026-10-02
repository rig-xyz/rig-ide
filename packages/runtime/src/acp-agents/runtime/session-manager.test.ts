import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { isOk } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_GRACE_MS } from '../connection/source';
import { FakeAcpTerminalProcess, makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

async function startHarness(conversationId = 'conv-1') {
  const h = makeAcpHarness();
  const rt = new AcpRuntime(h.deps);
  const result = await rt.startSession(makeStartInput({ conversationId }));
  expect(isOk(result)).toBe(true);
  return { h, rt, client: h.client(), sessionId: 'session-1', conversationId };
}

describe('AcpRuntime session manager', () => {
  it('maps ACP auth_required JSON-RPC errors to auth_required', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockRejectedValueOnce({ code: -32000, message: 'Authentication required' });

    const result = await rt.startSession(makeStartInput({ conversationId: 'conv-auth-required' }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('auth_required');
  });

  it("keeps the adapter's details when newSession fails with a bare Internal error", async () => {
    // What claude-agent-acp answers when the host claude binary can't be
    // spawned (an Intel-only build on a Mac without Rosetta).
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockRejectedValueOnce(
      Object.assign(new Error('Internal error'), {
        code: -32603,
        data: { details: 'spawn Unknown system error -86' },
      })
    );

    const result = await rt.startSession(makeStartInput({ conversationId: 'conv-bad-cpu' }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('new_session_failed');
    expect(result.error.type === 'new_session_failed' && result.error.cause?.message).toBe(
      'Internal error: spawn Unknown system error -86'
    );
  });

  it('shares one process for conversations in the same provider/workspace and releases on last stop', async () => {
    // Only the keep-warm grace window's own timer is faked — everything else
    // (the harness's microtask plumbing) stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = makeAcpHarness();
      const rt = new AcpRuntime(h.deps);
      h.agent.newSession
        .mockResolvedValueOnce({ sessionId: 'session-a' })
        .mockResolvedValueOnce({ sessionId: 'session-b' });

      await rt.startSession(makeStartInput({ conversationId: 'conv-a', workspaceId: 'ws-1' }));
      await rt.startSession(makeStartInput({ conversationId: 'conv-b', workspaceId: 'ws-1' }));

      expect(h.children).toHaveLength(1);
      rt.stopSession('conv-a');
      expect(h.lastChild.kill).not.toHaveBeenCalled();
      // The last stop starts the connection pool's keep-warm grace window
      // (`connection/source.ts` CONNECTION_GRACE_MS) rather than killing the
      // process — a prompt follow-up session on the same workspace reuses
      // it. Only the window lapsing tears the process down.
      rt.stopSession('conv-b');
      expect(h.lastChild.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_MS);
      expect(h.lastChild.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes activeTurn patches without root replacement during incremental text growth', async () => {
    const { h, rt, client, sessionId } = await startHarness('conv-live');
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    h.agent.prompt = vi.fn(
      () =>
        new Promise<{ stopReason: 'end_turn' }>((resolve) => {
          resolvePrompt = resolve;
        })
    );
    const live = rt.sessionLiveModels('conv-live');
    if (!live) throw new Error('expected live models');
    const updates: Array<{ delta: unknown }> = [];
    const unsubscribe = live.states.activeTurn.subscribe((update) => updates.push(update));

    const prompt = rt.sendPrompt('conv-live', { text: 'hello' });
    updates.length = 0;
    await client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        sessionId,
        messageId: 'msg-1',
        content: { type: 'text', text: 'hel' },
      } as SessionUpdate,
    });
    updates.length = 0;
    await client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        sessionId,
        messageId: 'msg-1',
        content: { type: 'text', text: 'lo' },
      } as SessionUpdate,
    });

    const patches = updates.flatMap((update) => update.delta as Array<{ path: unknown[] }>);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((patch) => patch.path.length > 0)).toBe(true);
    unsubscribe();
    resolvePrompt({ stopReason: 'end_turn' });
    await prompt;
  });

  it('publishes usage updates through live models', async () => {
    const { rt, client, sessionId } = await startHarness('conv-usage');
    const live = rt.sessionLiveModels('conv-usage');
    if (!live) throw new Error('expected live models');
    const updates: unknown[] = [];
    const unsubscribe = live.states.usage.subscribe((update) => updates.push(update));

    await client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'usage_update',
        sessionId,
        used: 42_000,
        size: 200_000,
        cost: { amount: 0.25, currency: 'USD' },
      } as SessionUpdate,
    });

    expect(live.states.usage.snapshot().data).toEqual({
      contextUsed: 42_000,
      contextSize: 200_000,
      cost: { amount: 0.25, currency: 'USD' },
    });
    expect(updates.length).toBeGreaterThan(0);
    unsubscribe();
  });

  it('keeps stored attachment ids in user transcript messages', async () => {
    const resolveAttachment = vi.fn().mockResolvedValue({
      data: 'base64-image',
      mimeType: 'image/png',
    });
    const h = makeAcpHarness({ resolveAttachment });
    const rt = new AcpRuntime(h.deps);
    const started = await rt.startSession(makeStartInput({ conversationId: 'conv-attachment' }));
    expect(isOk(started)).toBe(true);

    const sent = await rt.sendPrompt('conv-attachment', {
      text: 'look',
      attachments: [
        {
          type: 'attachment',
          id: 'attachment-1',
          name: 'image.png',
          mimeType: 'image/png',
        },
      ],
    });

    expect(isOk(sent)).toBe(true);
    expect(resolveAttachment).toHaveBeenCalledWith({
      type: 'attachment',
      id: 'attachment-1',
      name: 'image.png',
      mimeType: 'image/png',
    });
    expect(h.agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [
        { type: 'image', data: 'base64-image', mimeType: 'image/png' },
        { type: 'text', text: 'look' },
      ],
    });

    const history = rt.getHistory('conv-attachment');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.data.turns[0].items[0]).toMatchObject({
      kind: 'message',
      text: 'look',
      attachments: [{ id: 'attachment-1', name: 'image.png', mimeType: 'image/png' }],
    });
  });

  it('sends hidden prompt context to the agent without adding it to the transcript', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const started = await rt.startSession(
      makeStartInput({ conversationId: 'conv-hidden-context' })
    );
    expect(isOk(started)).toBe(true);

    const sent = await rt.sendPrompt('conv-hidden-context', {
      text: 'Fix @[ENG-123](issue:linear:ENG-123)',
      hiddenContext: '<issue_context identifier="ENG-123">Context body</issue_context>',
    });

    expect(isOk(sent)).toBe(true);
    expect(h.agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'Fix @[ENG-123](issue:linear:ENG-123)' },
        { type: 'text', text: '<issue_context identifier="ENG-123">Context body</issue_context>' },
      ],
    });

    const history = rt.getHistory('conv-hidden-context');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.data.turns[0].items[0]).toMatchObject({
      kind: 'message',
      text: 'Fix @[ENG-123](issue:linear:ENG-123)',
    });
    expect(JSON.stringify(history.data.turns[0].items[0])).not.toContain('Context body');
  });

  it("hands the session's own MCP servers to the agent on new and load, and none by default", async () => {
    const server = { type: 'http' as const, name: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] };
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({ conversationId: 'conv-plain' }));
    expect(h.agent.newSession).toHaveBeenLastCalledWith(expect.objectContaining({ mcpServers: [] }));

    await rt.startSession({ ...makeStartInput({ conversationId: 'conv-mcp' }), mcpServers: [server] });
    expect(h.agent.newSession).toHaveBeenLastCalledWith(expect.objectContaining({ mcpServers: [server] }));

    h.agent.loadSession = vi.fn(async () => ({}));
    await rt.resumeSession({ ...makeStartInput({ conversationId: 'conv-load' }), sessionId: 'session-old', mcpServers: [server] });
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-old', mcpServers: [server] }));
  });

  it("keeps a Claude session's held-back .mcp.json servers out through its flag settings, on new and load", async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const meta = { claudeCode: { options: { settings: { disabledMcpjsonServers: ['customerio'] } } } };
    await rt.startSession({ ...makeStartInput({ conversationId: 'conv-held' }), disabledProjectMcpServers: ['customerio'] });
    expect(h.agent.newSession).toHaveBeenLastCalledWith(expect.objectContaining({ _meta: meta }));

    h.agent.loadSession = vi.fn(async () => ({}));
    await rt.resumeSession({ ...makeStartInput({ conversationId: 'conv-held-load' }), sessionId: 'session-old', disabledProjectMcpServers: ['customerio'] });
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ _meta: meta }));

    await rt.startSession(makeStartInput({ conversationId: 'conv-none' }));
    expect(h.agent.newSession).toHaveBeenLastCalledWith(expect.not.objectContaining({ _meta: expect.anything() }));
    await rt.startSession({ ...makeStartInput({ conversationId: 'conv-codex', providerId: 'codex' }), disabledProjectMcpServers: ['x'] });
    expect(h.agent.newSession).toHaveBeenLastCalledWith(expect.not.objectContaining({ _meta: expect.anything() }));
  });

  it('waits for a closing session to finish closing before loading it again', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const order: string[] = [];
    let finishClose!: () => void;
    h.agent.closeSession = vi.fn(() => new Promise<Record<string, never>>((resolve) => (finishClose = () => { order.push('closed'); resolve({}); })));
    h.agent.loadSession = vi.fn(async () => {
      order.push('load');
      return {};
    });
    await rt.startSession(makeStartInput({ conversationId: 'conv-reload' }));
    rt.stopSession('conv-reload');

    const resumed = rt.resumeSession({ ...makeStartInput({ conversationId: 'conv-reload' }), sessionId: 'session-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    finishClose();
    expect(isOk(await resumed)).toBe(true);
    expect(order).toEqual(['closed', 'load']);
  });

  it('joins a start already under way for the same conversation instead of refusing it or handing out a half-loaded session', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    let finishLoad!: () => void;
    h.agent.loadSession = vi.fn(() => new Promise<Record<string, never>>((resolve) => (finishLoad = () => resolve({}))));
    h.agent.prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }));

    // A slow resume (loading history), and meanwhile a second resume and a
    // fresh start of the same conversation.
    const first = rt.resumeSession({ ...makeStartInput({ conversationId: 'conv-race' }), sessionId: 'session-old' });
    await vi.waitFor(() => expect(h.agent.loadSession).toHaveBeenCalledTimes(1));
    const second = rt.resumeSession({ ...makeStartInput({ conversationId: 'conv-race' }), sessionId: 'session-old' });
    const fresh = rt.startSession(makeStartInput({ conversationId: 'conv-race' }));
    let freshDone = false;
    void fresh.then(() => (freshDone = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(freshDone).toBe(false);

    finishLoad();
    for (const result of [await first, await second, await fresh]) {
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.data.sessionId).toBe('session-old');
    }
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(h.agent.newSession).not.toHaveBeenCalled();
    // The session they all got takes a prompt.
    expect(isOk(await rt.sendPrompt('conv-race', { text: 'the second one' }))).toBe(true);
  });

  it('returns a resume result with replayed history', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession = vi.fn(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-old',
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId: 'session-old',
          messageId: 'msg-1',
          content: { type: 'text', text: 'from history' },
        } as SessionUpdate,
      });
      return {};
    });

    const result = await rt.resumeSession({
      ...makeStartInput({ conversationId: 'conv-resume' }),
      sessionId: 'session-old',
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.sessionId).toBe('session-old');
    expect(result.data.turns).toHaveLength(1);
    expect(result.data.turns[0].items[0]).toMatchObject({
      kind: 'message',
      text: 'from history',
    });
  });

  it('publishes terminal state and output through live primitives', async () => {
    const { h, rt, client, sessionId } = await startHarness('conv-terminal');
    const terminal = new FakeAcpTerminalProcess();
    h.fakeHost.nextTerminal = terminal;
    const created = await client.createTerminal!({
      sessionId,
      command: 'echo',
      args: [],
      cwd: '/tmp',
    });

    expect(rt.sessionLiveModels('conv-terminal')?.states.terminals.snapshot().data).toMatchObject([
      { terminalId: created.terminalId, command: 'echo', exitStatus: null },
    ]);

    const log = rt.terminalOutputLog(created.terminalId);
    if (!log) throw new Error('expected terminal log');
    const updates: unknown[] = [];
    const unsub = log.subscribe((update) => updates.push(update));
    terminal.pushOutput('hello');

    terminal.pushOutput(' world');

    expect(log.snapshot().data.text).toBe('hello world');
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({ delta: { chunk: ' world' } });

    terminal.triggerExit({ exitCode: 0, signal: null });
    expect(rt.sessionLiveModels('conv-terminal')?.states.terminals.snapshot().data).toMatchObject([
      { terminalId: created.terminalId, exitStatus: { exitCode: 0, signal: null } },
    ]);
    unsub();
  });

  it('removes sessions when the process closes', async () => {
    const { h, rt } = await startHarness('conv-close');

    h.lastChild.emitExit(42);

    // The exit event resolves through a `.then` on the connection's
    // `processClosed` promise (acp-agent-connection.ts), so the runtime's
    // lifecycle flip lands a microtask after `emitExit` returns, not
    // synchronously — same contract asserted with `vi.waitFor` in
    // connection/acp-agent-connection.test.ts and connection/source.test.ts.
    await vi.waitFor(() => expect(rt.getSessionState('conv-close').lifecycle).toBe('closed'));
    expect(rt.sessionLiveModels('conv-close')).toBeNull();
    expect(rt.sessionsListLiveModel().states.list.snapshot().data).toEqual({});
  });

  it('removes all sessions sharing a process when that process closes', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({ sessionId: 'session-b' });

    await rt.startSession(makeStartInput({ conversationId: 'conv-a', workspaceId: 'ws-1' }));
    await rt.startSession(makeStartInput({ conversationId: 'conv-b', workspaceId: 'ws-1' }));
    expect(h.children).toHaveLength(1);

    h.lastChild.emitExit(42);

    await vi.waitFor(() => expect(rt.getSessionState('conv-a').lifecycle).toBe('closed'));
    expect(rt.getSessionState('conv-b').lifecycle).toBe('closed');
    expect(rt.sessionLiveModels('conv-a')).toBeNull();
    expect(rt.sessionLiveModels('conv-b')).toBeNull();
    expect(rt.sessionsListLiveModel().states.list.snapshot().data).toEqual({});
  });

  describe('observeRawSessionEvents', () => {
    it('does not change transcript reduction when no observer is registered', async () => {
      const { rt, client, sessionId, conversationId } = await startHarness('conv-raw-unaffected');
      const live = rt.sessionLiveModels(conversationId);
      if (!live) throw new Error('expected live models');
      const updates: unknown[] = [];
      const unsub = live.states.activeTurn.subscribe((u) => updates.push(u));

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'hi' },
        } as SessionUpdate,
      });

      expect(updates.length).toBeGreaterThan(0);
      unsub();
    });

    it('delivers raw session updates to a registered observer, in order, alongside normal reduction', async () => {
      const { rt, client, sessionId, conversationId } = await startHarness('conv-raw-order');
      const live = rt.sessionLiveModels(conversationId);
      if (!live) throw new Error('expected live models');
      const reduced: unknown[] = [];
      const unsub = live.states.activeTurn.subscribe((u) => reduced.push(u));

      const seen: SessionUpdate[] = [];
      const unobserve = rt.observeRawSessionEvents(conversationId, (raw) => {
        if (raw.kind !== 'acp_update') return;
        expect(raw.sessionId).toBe(sessionId);
        seen.push(raw.update);
      });

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'hel' },
        } as SessionUpdate,
      });
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'lo' },
        } as SessionUpdate,
      });

      expect(seen.map((u) => (u as { content: { text: string } }).content.text)).toEqual([
        'hel',
        'lo',
      ]);
      // The reduction the observer rides alongside still happened normally.
      expect(reduced.length).toBeGreaterThan(0);

      unobserve();
      unsub();
    });

    it('logs and continues when an observer throws, without breaking the session or other observers', async () => {
      const { h, rt, client, sessionId, conversationId } = await startHarness('conv-raw-throw');
      const errorSpy = vi.spyOn(h.deps.logger, 'error').mockImplementation(() => {});
      try {
        const otherSeen: SessionUpdate[] = [];
        rt.observeRawSessionEvents(conversationId, () => {
          throw new Error('boom');
        });
        rt.observeRawSessionEvents(conversationId, (raw) => {
          if (raw.kind === 'acp_update') otherSeen.push(raw.update);
        });

        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            sessionId,
            messageId: 'msg-1',
            content: { type: 'text', text: 'hi' },
          } as SessionUpdate,
        });

        expect(otherSeen).toHaveLength(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('raw session event observer threw'),
          expect.objectContaining({ conversationId })
        );
        // The session itself is unaffected — still reachable, still live.
        expect(rt.getSessionState(conversationId).lifecycle).toBe('ready');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('stops delivering events after unsubscribe', async () => {
      const { rt, client, sessionId, conversationId } = await startHarness('conv-raw-unsub');
      const seen: SessionUpdate[] = [];
      const unobserve = rt.observeRawSessionEvents(conversationId, (raw) => {
        if (raw.kind === 'acp_update') seen.push(raw.update);
      });
      unobserve();

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'hi' },
        } as SessionUpdate,
      });

      expect(seen).toHaveLength(0);
    });
  });

  describe('sessionRawEventsLog', () => {
    it('only starts capturing once something asks for the log (opt-in)', async () => {
      const { rt, client, sessionId, conversationId } = await startHarness('conv-rawlog-optin');

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'before' },
        } as SessionUpdate,
      });

      // Asked for now, after the fact — the log starts empty; it never
      // retroactively captures events that happened before it existed.
      const log = rt.sessionRawEventsLog(conversationId);
      expect(log.snapshot().data.text).toBe('');

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'after' },
        } as SessionUpdate,
      });

      const lines = log
        .snapshot()
        .data.text.split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { sessionId: string; update: SessionUpdate });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.sessionId).toBe(sessionId);
      expect((lines[0]?.update as { content: { text: string } }).content.text).toBe('after');
    });

    it('returns the same log instance on repeated calls for the same conversation', async () => {
      const { rt, conversationId } = await startHarness('conv-rawlog-same');
      expect(rt.sessionRawEventsLog(conversationId)).toBe(rt.sessionRawEventsLog(conversationId));
    });
  });

  describe('in-band turn boundaries and raw-log cleanup', () => {
    type Seen = { kind: string; update?: string; stopReason?: string | null; turnId?: string };

    function record(rt: AcpRuntime, conversationId: string): Seen[] {
      const seen: Seen[] = [];
      rt.observeRawSessionEvents(conversationId, (raw) => {
        if (raw.kind === 'acp_update') seen.push({ kind: raw.kind, update: raw.update.sessionUpdate });
        else if (raw.kind === 'turn_end')
          seen.push({ kind: raw.kind, turnId: raw.turnId, stopReason: raw.stopReason });
        else seen.push({ kind: raw.kind, turnId: raw.turnId });
      });
      return seen;
    }

    it("brackets a turn's updates with turn_start and turn_end, same turnId, carrying the stop reason", async () => {
      const { h, rt, client, sessionId, conversationId } = await startHarness('conv-markers');
      const seen = record(rt, conversationId);
      h.agent.prompt.mockImplementationOnce(async () => {
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            sessionId,
            messageId: 'msg-1',
            content: { type: 'text', text: 'the answer' },
          } as SessionUpdate,
        });
        return { stopReason: 'end_turn' };
      });

      expect(isOk(await rt.sendPrompt(conversationId, { text: 'go' }))).toBe(true);

      await vi.waitFor(() => expect(seen.at(-1)?.kind).toBe('turn_end'));
      expect(seen.map((e) => e.kind)).toEqual(['turn_start', 'acp_update', 'turn_end']);
      expect(seen[1]?.update).toBe('agent_message_chunk');
      expect(seen[2]).toMatchObject({ stopReason: 'end_turn', turnId: seen[0]?.turnId });
    });

    it('emits turn_end with the cancelled stop reason for a cancelled turn', async () => {
      const { h, rt, conversationId } = await startHarness('conv-markers-cancel');
      const seen = record(rt, conversationId);
      h.agent.prompt.mockResolvedValueOnce({ stopReason: 'cancelled' });

      await rt.sendPrompt(conversationId, { text: 'go' });

      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: 'turn_end', stopReason: 'cancelled' }));
    });

    it('emits turn_end with a null stop reason when the prompt fails', async () => {
      const { h, rt, conversationId } = await startHarness('conv-markers-error');
      const seen = record(rt, conversationId);
      h.agent.prompt.mockRejectedValueOnce(new Error('agent crashed'));

      await rt.sendPrompt(conversationId, { text: 'go' });

      await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ kind: 'turn_end', stopReason: null }));
      expect(seen.map((e) => e.kind)).toEqual(['turn_start', 'turn_end']);
    });

    it('never writes available_commands_update into the raw log', async () => {
      const { rt, client, sessionId, conversationId } = await startHarness('conv-rawlog-filter');
      const log = rt.sessionRawEventsLog(conversationId);

      await client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] } as SessionUpdate,
      });
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId,
          messageId: 'msg-1',
          content: { type: 'text', text: 'kept' },
        } as SessionUpdate,
      });

      const kinds = log
        .snapshot()
        .data.text.split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { update?: { sessionUpdate: string } }).update?.sessionUpdate);
      expect(kinds).toEqual(['agent_message_chunk']);
    });

    it("keeps a conversation's raw log and observers when a failed resume falls back to a new session", async () => {
      const h = makeAcpHarness();
      const rt = new AcpRuntime(h.deps);
      const conversationId = 'conv-resume-fallback';
      // Subscribed before the session starts, as the Spaces dispatcher does.
      const log = rt.sessionRawEventsLog(conversationId);
      const observer = vi.fn();
      rt.observeRawSessionEvents(conversationId, observer);
      h.agent.loadSession = vi.fn(async () => {
        throw new Error('thread not found');
      });

      const started = await rt.startSession(makeStartInput({ conversationId, sessionId: 'session-old' }));
      expect(isOk(started)).toBe(true);
      const sessionId = isOk(started) ? started.data.sessionId : '';
      expect(sessionId).not.toBe('session-old');

      await h.client().sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', sessionId, messageId: 'm1', content: { type: 'text', text: 'OK' } } as SessionUpdate,
      });
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'acp_update', sessionId }));
      expect(rt.sessionRawEventsLog(conversationId)).toBe(log);
      expect(log.snapshot().data.text).toContain('"OK"');
    });

    it("disposes a conversation's raw log and observers when its session is removed", async () => {
      const { h, rt, conversationId } = await startHarness('conv-rawlog-dispose');
      const before = rt.sessionRawEventsLog(conversationId);
      const observer = vi.fn();
      rt.observeRawSessionEvents(conversationId, observer);

      h.lastChild.emitExit(42);
      await vi.waitFor(() => expect(rt.getSessionState(conversationId).lifecycle).toBe('closed'));

      // A later request for the same conversation gets a fresh log, not the stale buffer.
      expect(rt.sessionRawEventsLog(conversationId)).not.toBe(before);

      // A new session under the same conversation id must not reach the old observer.
      const restarted = await rt.startSession(makeStartInput({ conversationId }));
      expect(isOk(restarted)).toBe(true);
      await rt.sendPrompt(conversationId, { text: 'go' });
      await vi.waitFor(() => expect(h.agent.prompt).toHaveBeenCalled());
      expect(observer).not.toHaveBeenCalled();
    });
  });
});
