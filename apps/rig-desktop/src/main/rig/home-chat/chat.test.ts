import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RawSessionEvent } from '../spaces/dispatch';
import type { HomeChatRun } from '@shared/rig/home-chat';
import { createHomeChat, HOME_CHAT_RULES, homeChatPermission, homeChatSelf, type HomeChatDeps } from './chat';

const request = (title: string): AcpPermissionRequest =>
  ({
    requestId: 'r1',
    toolCall: { title },
    options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'always', kind: 'allow_always', name: 'Always' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' },
    ],
  }) as unknown as AcpPermissionRequest;

/** A fake ACP runtime whose turns answer with `reply(text)`. */
function fakeAcp(reply: (text: string) => string) {
  const listeners = new Map<string, Set<(e: RawSessionEvent) => void>>();
  let permissions: ((r: AcpPermissionRequest) => void) | null = null;
  const acp = {
    startSession: vi.fn(async (_input: Record<string, unknown>) => ok({ sessionId: 's1' })),
    setConfig: vi.fn(async (_id: string, _change: Record<string, unknown>) => ok(undefined)),
    stopSession: vi.fn(async () => {}),
    subscribeRaw: vi.fn(async (id: string, on: (e: RawSessionEvent) => void) => {
      const set = listeners.get(id) ?? new Set();
      set.add(on);
      listeners.set(id, set);
      return () => set.delete(on);
    }),
    cancelTurn: vi.fn(async () => {}),
    readModel: vi.fn(async () => 'claude-opus-5-5'),
    subscribePendingPermissions: vi.fn(async (_id: string, on: (r: AcpPermissionRequest) => void) => {
      permissions = on;
      return () => (permissions = null);
    }),
    resolvePermission: vi.fn(async () => {}),
    queuePrompt: vi.fn(async (id: string, text: string) => {
      setTimeout(() => {
        const emit = (e: RawSessionEvent) => listeners.get(id)?.forEach((on) => on(e));
        emit({ kind: 'turn_start', turnId: 't' });
        const answer = reply(text);
        for (const part of [answer.slice(0, 5), answer.slice(5)])
          emit({ kind: 'acp_update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: part } } });
        emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
      }, 0);
      return ok({ turnId: null });
    }),
  };
  return { acp, askPermission: (r: AcpPermissionRequest) => permissions?.(r) };
}

function deps(acp: HomeChatDeps['acp'], over: Partial<HomeChatDeps> = {}): HomeChatDeps {
  let n = 0;
  return {
    acp,
    rigTools: vi.fn(async () => ({ type: 'http', name: 'rig', url: 'http://127.0.0.1/mcp', headers: [] }) as never),
    whoami: async () => ok({ id: 'usr_me' }),
    cwd: async () => '/tmp/home-chat',
    newConversationId: () => `home-${++n}`,
    issueTurn: () => `turn_${n}`,
    selfNames: async () => ['Dylan Bourgeois'],
    ...over,
  };
}

describe('Home chat', () => {
  it("starts one Claude session with Rig's tools and the Home rules, and answers each turn", async () => {
    const { acp } = fakeAcp((text) => `You asked: ${text}`);
    const d = deps(acp);
    const chat = createHomeChat(d);
    expect(await chat.send('what needs me?')).toEqual(ok({ text: 'You asked: what needs me?' }));
    expect(await chat.send('and now?')).toEqual(ok({ text: 'You asked: and now?' }));
    expect(acp.startSession).toHaveBeenCalledTimes(1);
    expect(acp.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', cwd: '/tmp/home-chat', systemPromptAppend: `${HOME_CHAT_RULES}\n${homeChatSelf(['Dylan Bourgeois'])}` })
    );
    expect(d.rigTools).toHaveBeenCalledWith({ bindingId: 'home', ownerUserId: 'usr_me', agent: 'claude', cwd: '/tmp/home-chat' });
  });

  it("gives each of the person's messages a fresh user_turn_id, out of sight", async () => {
    const { acp } = fakeAcp(() => 'ok');
    const chat = createHomeChat(deps(acp));
    await chat.send('start a session with task x');
    expect(acp.queuePrompt).toHaveBeenCalledWith('home-1', 'start a session with task x', '<rig_turn user_turn_id="turn_1" />', expect.any(Function));
  });

  it('opens one session for the renderer to show, however many ask at once', async () => {
    const { acp } = fakeAcp(() => 'x');
    const chat = createHomeChat(deps(acp));
    const [a, b] = await Promise.all([chat.open(), chat.open()]);
    expect(a).toEqual(ok({ conversationId: 'home-1', cwd: '/tmp/home-chat' }));
    expect(b).toEqual(a);
    expect(acp.startSession).toHaveBeenCalledTimes(1);
    expect(chat.turnContext()).toMatch(/^<rig_turn user_turn_id="turn_\d+" \/>$/);
  });

  it('records each message as a run, with the session updates the Room card draws', async () => {
    const { acp } = fakeAcp(() => 'Two things need you.');
    const runs: HomeChatRun[] = [];
    const chat = createHomeChat(deps(acp, { onRun: (r) => runs.push(r) }));
    expect(await chat.ask('what needs me?')).toEqual(ok({ runId: expect.any(String) }));
    await vi.waitFor(() => expect(chat.runs()[0]?.status).toBe('done'));
    const [run] = chat.runs();
    expect(run).toMatchObject({ prompt: 'what needs me?', model: 'claude-opus-5-5' });
    expect(run!.events.map((e) => e.kind)).toEqual(['run_model', 'agent_message_chunk', 'agent_message_chunk', 'turn_ended']);
    expect(runs.at(-1)?.status).toBe('done');
    expect(acp.queuePrompt).toHaveBeenCalledWith('home-1', 'what needs me?', expect.stringMatching(/^<rig_turn /), expect.any(Function));
  });

  it('knows which name in Rig\'s data is the person, and starts on their own model', async () => {
    expect(homeChatSelf(['Dylan Bourgeois', 'Dylan Bourgeois', ''])).toContain('In Rig\'s data (cards, messages, tickets, PRs) they appear as Dylan Bourgeois, or by first name: that is them');
    expect(homeChatSelf([])).toBe('');
    const { acp } = fakeAcp(() => 'x');
    await createHomeChat(deps(acp)).open();
    expect((acp.startSession.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).not.toHaveProperty('model');
  });

  it('runs turns one at a time', async () => {
    const order: string[] = [];
    const { acp } = fakeAcp((text) => {
      order.push(text);
      return `ok ${text}`;
    });
    const chat = createHomeChat(deps(acp));
    const [a, b] = await Promise.all([chat.send('one'), chat.send('two')]);
    expect([a, b]).toEqual([ok({ text: 'ok one' }), ok({ text: 'ok two' })]);
    expect(order).toEqual(['one', 'two']);
  });

  it('allows the Feed tools once and refuses everything else', async () => {
    expect(homeChatPermission(request('mcp__rig__rig_act'))).toBe('allow');
    expect(homeChatPermission(request('mcp__rig__rig_start'))).toBe('allow');
    expect(homeChatPermission(request('mcp__rig__rig_query'))).toBe('allow');
    expect(homeChatPermission(request('mcp__rig__rig_chat_read'))).toBe('no');
    expect(homeChatPermission(request('Bash'))).toBe('no');
    const { acp, askPermission } = fakeAcp(() => 'x');
    const chat = createHomeChat(deps(acp));
    await chat.send('hi');
    askPermission(request('mcp__rig__rig_get'));
    expect(acp.resolvePermission).toHaveBeenCalledWith('home-1', 'r1', 'allow');
  });

  it('says why when there is no account or Claude cannot start', async () => {
    const { acp } = fakeAcp(() => 'x');
    expect(await createHomeChat(deps(acp, { whoami: async () => err({ message: 'Not signed in to Rig.' }) })).send('hi')).toEqual(
      err('Not signed in to Rig.')
    );
    acp.startSession.mockResolvedValueOnce(err('Claude is not installed') as never);
    expect(await createHomeChat(deps(acp)).send('hi')).toEqual(err('Claude is not installed'));
  });

  it("is locked down whatever the person's own Claude settings allow: deny rules, no bypass, no settings allow rules, Ask first", async () => {
    const { acp } = fakeAcp(() => 'x');
    await createHomeChat(deps(acp)).send('hi');
    const input = acp.startSession.mock.calls[0]![0];
    expect(input).toMatchObject({ noBypassPermissions: true, appPermissionsOnly: true });
    expect(input.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']));
    // rig_start stays: it checks the person's own turn.
    expect(input.disallowedTools).not.toContain('mcp__rig__rig_start');
    expect(acp.setConfig).toHaveBeenCalledWith('home-1', { mode: 'default' });
  });

  it("doesn't chat when the session can't be put in Ask first", async () => {
    const { acp } = fakeAcp(() => 'x');
    acp.setConfig.mockResolvedValueOnce(err('no modes') as never);
    expect(await createHomeChat(deps(acp)).send('hi')).toEqual(err("Couldn't start a safe session for Home: no modes"));
    expect(acp.queuePrompt).not.toHaveBeenCalled();
    expect(acp.stopSession).toHaveBeenCalledWith('home-1');
  });

  it('reset closes the session, and the next message starts a new one', async () => {
    const { acp } = fakeAcp(() => 'x');
    const chat = createHomeChat(deps(acp));
    await chat.send('hi');
    await chat.reset();
    expect(acp.stopSession).toHaveBeenCalledWith('home-1');
    await chat.send('again');
    expect(acp.startSession).toHaveBeenCalledTimes(2);
  });
});
