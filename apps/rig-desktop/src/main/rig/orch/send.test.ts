import type { AcpPermissionRequest } from '@emdash/core/acp';
import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RigFeedCard } from '@shared/rig/feed';
import type { RawSessionEvent } from '../spaces/dispatch';
import { createSender, parseTarget, sendPermission } from './send';
import { createTurnGate } from './turns';

const perm = (title: string, rawInput: Record<string, unknown>) =>
  ({ requestId: 'r', toolCall: { title, rawInput }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }) as unknown as AcpPermissionRequest;
const SEND = 'mcp__claude_ai_Slack__slack_send_message';

const card = (draft: { text: string; target: string }, verb: 'send' | 'post' = 'send'): RigFeedCard => ({
  title: 'Reply to Priya about the pilot',
  why: 'Priya asked [msg:slack:C0P:1.2].',
  action: '',
  people: [],
  refsOk: true,
  choices: [
    { verb, label: 'Say yes', lead: 'Say yes', tail: '', draft: { label: 'Your reply', ...draft } },
    { verb: 'start', label: 'Gather', lead: 'Gather the numbers', tail: '' },
  ],
});

/** A Claude session that calls the tools it's given, as a real one would. */
function fakeAcp(calls: { name: string; input: Record<string, unknown>; ok?: boolean }[], onPermission: (r: AcpPermissionRequest) => void = () => {}) {
  let emit: (e: RawSessionEvent) => void = () => {};
  let perms: (r: AcpPermissionRequest) => void = () => {};
  const resolved: string[] = [];
  const acp = {
    startSession: vi.fn(async () => ok({ sessionId: 's' })),
    setConfig: vi.fn(async () => ok(undefined)),
    stopSession: vi.fn(async () => {}),
    subscribeRaw: vi.fn(async (_c: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
    subscribePendingPermissions: vi.fn(async (_c: string, on: (r: AcpPermissionRequest) => void) => ((perms = on), () => {})),
    resolvePermission: vi.fn(async (_c: string, _r: string, optionId: string) => void resolved.push(optionId)),
    queuePrompt: vi.fn(async () => {
      setTimeout(() => {
        emit({ kind: 'turn_start', turnId: 't' });
        calls.forEach((c, i) => {
          const id = `tc${i}`;
          emit({ kind: 'acp_update', update: { sessionUpdate: 'tool_call', toolCallId: id, name: c.name, rawInput: c.input } } as never);
          const request = perm(c.name, c.input);
          onPermission(request);
          perms(request);
          const allowed = resolved.at(-1) === 'yes';
          emit({ kind: 'acp_update', update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: allowed && c.ok !== false ? 'completed' : 'failed', rawOutput: [{ type: 'text', text: allowed ? '{"message_link":"https:\\/\\/acme.slack.com\\/archives\\/C0P\\/p123"}' : 'refused' }] } } as never);
        });
        emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
      }, 0);
      return ok({ turnId: null });
    }),
  };
  return { acp, resolved };
}

function deps(over: Partial<Parameters<typeof createSender>[0]> = {}) {
  const turns = createTurnGate();
  return {
    turns,
    d: {
      card: vi.fn(async () => ok(card({ text: 'Yes, I’ll be there.', target: 'msg:slack:C0P:1.2' }))),
      gh: vi.fn(async () => ok('https://github.com/acme/api/pull/212#issuecomment-1\n')),
      acp: fakeAcp([]).acp,
      cwd: async () => '/Rig/home',
      newConversationId: () => 'send-1',
      answered: vi.fn(async () => {}),
      turns,
      ...over,
    } as Parameters<typeof createSender>[0],
  };
}

describe('Send and Post', () => {
  it('reads where a draft goes', () => {
    expect(parseTarget('msg:slack:C0P:1792703213.894549')).toEqual({ kind: 'slack', channel: 'C0P', thread: '1792703213.894549' });
    expect(parseTarget('msg:slack:U0ME')).toEqual({ kind: 'slack', channel: 'U0ME', thread: null });
    expect(parseTarget('github:acme/api#212')).toEqual({ kind: 'github', repo: 'acme/api', number: '212' });
    expect(parseTarget('msg:gmail:abc')).toBeNull();
  });

  it('allows the one send, once, with this channel, thread and words; refuses anything else', () => {
    const permit = sendPermission({ channel: 'C0P', thread: '1.2', text: 'Yes, I’ll be there.' });
    expect(permit(perm(SEND, { channel_id: 'C0P', thread_ts: '1.2', message: 'Yes, I’ll be there.' }))).toBe('yes');
    // Never twice.
    expect(permit(perm(SEND, { channel_id: 'C0P', thread_ts: '1.2', message: 'Yes, I’ll be there.' }))).toBe('no');
    const fresh = () => sendPermission({ channel: 'C0P', thread: '1.2', text: 'Yes, I’ll be there.' });
    expect(fresh()(perm(SEND, { channel_id: 'C0OTHER', thread_ts: '1.2', message: 'Yes, I’ll be there.' }))).toBe('no');
    expect(fresh()(perm(SEND, { channel_id: 'C0P', message: 'Yes, I’ll be there.' }))).toBe('no');
    expect(fresh()(perm(SEND, { channel_id: 'C0P', thread_ts: '1.2', message: 'Yes, I’ll be there! And more.' }))).toBe('no');
    expect(fresh()(perm(SEND, { channel_id: 'C0P', thread_ts: '1.2', message: 'Yes, I’ll be there.', reply_broadcast: true }))).toBe('no');
    expect(fresh()(perm('mcp__claude_ai_Slack__slack_read_channel', { channel_id: 'C0P' }))).toBe('no');
  });

  it('posts on GitHub with gh, the words on stdin, and tells Rig the card is done', async () => {
    const sent = vi.fn();
    const { d, turns } = deps({ card: vi.fn(async () => ok(card({ text: 'Is the 429 path covered?', target: 'github:acme/api#212' }, 'post'))), sent });
    const r = await createSender(d).send({ situationId: 'sit_1', choice: 0, text: 'Is the 429 path covered? (edited)' }, turns.issue('click'));
    expect(r).toEqual(ok({ said: 'Posted on api#212', link: 'https://github.com/acme/api/pull/212#issuecomment-1' }));
    expect(d.gh).toHaveBeenCalledWith(['issue', 'comment', '212', '--repo', 'acme/api', '--body-file', '-'], 'Is the 429 path covered? (edited)');
    expect(d.answered).toHaveBeenCalledWith('sit_1', 'Say yes');
    // Counted, never the words: posted, and changed from the draft.
    expect(sent).toHaveBeenCalledWith({ type: 'post', edited: true });
  });

  it('sends in Slack through a locked-down session, and counts it only when the send completes', async () => {
    const asked: string[] = [];
    const { acp } = fakeAcp([{ name: SEND, input: { channel_id: 'C0P', thread_ts: '1.2', message: 'Yes, I’ll be there.' } }], (r) => asked.push(String(r.toolCall.title)));
    const sent = vi.fn();
    const { d, turns } = deps({ acp, sent });
    const r = await createSender(d).send({ situationId: 'sit_1', choice: 0, text: 'Yes, I’ll be there.' }, turns.issue('click'));
    expect(sent).toHaveBeenCalledWith({ type: 'send', edited: false });
    expect(r).toEqual(ok({ said: 'Sent in the Slack thread', link: 'https://acme.slack.com/archives/C0P/p123' }));
    expect(acp.startSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Rig/home', noBypassPermissions: true, disallowedTools: expect.arrayContaining(['Bash', 'Write', 'WebFetch']) }));
    // The person's own allow rules (even one for slack_send_message) don't apply in it: the send always asks `sendPermission`.
    expect(acp.startSession).toHaveBeenCalledWith(expect.objectContaining({ appPermissionsOnly: true }));
    expect(asked).toEqual([SEND]);
    expect(acp.setConfig).toHaveBeenCalledWith('send-1', { mode: 'default' });
    expect(acp.stopSession).toHaveBeenCalledWith('send-1');
    expect(d.answered).toHaveBeenCalled();
  });

  it("doesn't count a session that changed the words, and leaves the card alone", async () => {
    const { acp } = fakeAcp([{ name: SEND, input: { channel_id: 'C0P', thread_ts: '1.2', message: 'Something else entirely.' } }]);
    const warn = vi.fn();
    const { d, turns } = deps({ acp, log: { info: vi.fn(), warn } });
    const r = await createSender(d).send({ situationId: 'sit_1', choice: 0, text: 'Yes, I’ll be there.' }, turns.issue('click'));
    expect(r.success).toBe(false);
    expect(d.answered).not.toHaveBeenCalled();
    // The log says it didn't go, never what Slack answered (it can quote the words).
    expect(warn).toHaveBeenCalledWith('Rig send: did not go', expect.objectContaining({ kind: 'slack', errorLength: expect.any(Number) }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('refused');
  });

  it('needs a fresh click, and a choice the card still has with words to send', async () => {
    const { d, turns } = deps();
    const sender = createSender(d);
    expect((await sender.send({ situationId: 'sit_1', choice: 0, text: 'x' }, 'turn_made_up')).success).toBe(false);
    expect(await sender.send({ situationId: 'sit_1', choice: 1, text: 'x' }, turns.issue('click'))).toMatchObject({ success: false, error: 'This card has nothing to send any more.' });
    expect(await sender.send({ situationId: 'sit_1', choice: 0, text: '   ' }, turns.issue('click'))).toMatchObject({ success: false });
    expect(d.gh).not.toHaveBeenCalled();
  });
});
