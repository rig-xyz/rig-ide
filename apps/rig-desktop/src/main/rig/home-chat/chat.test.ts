import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RawSessionEvent } from '../spaces/dispatch';
import { createHomeChat, HOME_CHAT_RULES, homeChatPermission, type HomeChatDeps } from './chat';

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
  const listeners = new Map<string, (e: RawSessionEvent) => void>();
  let permissions: ((r: AcpPermissionRequest) => void) | null = null;
  const acp = {
    startSession: vi.fn(async () => ok({ sessionId: 's1' })),
    stopSession: vi.fn(async () => {}),
    subscribeRaw: vi.fn(async (id: string, on: (e: RawSessionEvent) => void) => {
      listeners.set(id, on);
      return () => listeners.delete(id);
    }),
    subscribePendingPermissions: vi.fn(async (_id: string, on: (r: AcpPermissionRequest) => void) => {
      permissions = on;
      return () => (permissions = null);
    }),
    resolvePermission: vi.fn(async () => {}),
    queuePrompt: vi.fn(async (id: string, text: string) => {
      setTimeout(() => {
        const emit = listeners.get(id)!;
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
      expect.objectContaining({ providerId: 'claude', cwd: '/tmp/home-chat', systemPromptAppend: HOME_CHAT_RULES })
    );
    expect(d.rigTools).toHaveBeenCalledWith({ bindingId: 'home', ownerUserId: 'usr_me', agent: 'claude', cwd: '/tmp/home-chat' });
  });

  it("gives each of the person's messages a fresh user_turn_id, out of sight", async () => {
    const { acp } = fakeAcp(() => 'ok');
    const chat = createHomeChat(deps(acp));
    await chat.send('start a session with task x');
    expect(acp.queuePrompt).toHaveBeenCalledWith('home-1', 'start a session with task x', '<rig_turn user_turn_id="turn_1" />', expect.any(Function));
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
