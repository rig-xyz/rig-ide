import { describe, expect, it } from 'vitest';
import type { RigNotification } from '@shared/rig/notifications';
import { approveOption, rejectOption, sortPermissionOptions } from './approval-options';
import { computeForYou, diffArrivals, themesWithForYou, type ForYouSnapshot } from './for-you';
import type { RoomMessage, SessionEvent, SessionRunMeta } from './types';

const ME = 'me';
const BINDING = 'b1';

function message(id: string, seq: number, extra: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id,
    seq,
    authorId: 'maya',
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, seq)).toISOString(),
    time: '10:00',
    body: id,
    meta: { kind: 'text' },
    ...extra,
  };
}

function row(
  id: string,
  messageId: string | null,
  extra: Partial<RigNotification> = {}
): RigNotification {
  return {
    id,
    type: 'mention',
    tier: 'direct',
    bindingId: BINDING,
    spaceName: 'Launch',
    actor: { kind: 'user', userId: 'maya', name: 'Maya', agent: null },
    messageId,
    messageSeq: null,
    runId: null,
    requestId: null,
    inviteId: null,
    path: null,
    title: '',
    body: 'hey',
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, Number(id.replace(/\D/g, '')) || 0)).toISOString(),
    readAt: '2026-10-01T11:00:00Z',
    ...extra,
  };
}

function snapshot(messages: RoomMessage[], extra: Partial<ForYouSnapshot> = {}): ForYouSnapshot {
  return {
    messages,
    members: [
      { id: ME, name: 'Dylan', email: 'd@x.co', role: 'owner', initial: 'D', status: 'here' },
      { id: 'maya', name: 'Maya', email: 'm@x.co', role: 'editor', initial: 'M', status: 'here' },
    ],
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    ...extra,
  };
}

function compute(
  messages: RoomMessage[],
  notifications: RigNotification[],
  extra: { dismissed?: string[]; snap?: Partial<ForYouSnapshot> } = {}
) {
  return computeForYou({
    snapshot: snapshot(messages, extra.snap),
    selfUserId: ME,
    notifications,
    bindingId: BINDING,
    dismissed: new Set(extra.dismissed ?? []),
  });
}

describe('computeForYou: asks', () => {
  it('lists mention, reply and comment rows of this Space, oldest first', () => {
    const forYou = compute(
      [message('m1', 1), message('m2', 2), message('m3', 3)],
      [
        row('n3', 'm3', { type: 'comment' }),
        row('n1', 'm1', { type: 'mention' }),
        row('n2', 'm2', { type: 'reply' }),
      ]
    );
    expect(forYou.asks.map((a) => [a.messageId, a.type])).toEqual([
      ['m1', 'mention'],
      ['m2', 'reply'],
      ['m3', 'comment'],
    ]);
    expect(forYou.messageIds).toEqual(new Set(['m1', 'm2', 'm3']));
  });

  it('ignores other Spaces, ambient rows, other types, rows without a message and your own', () => {
    const forYou = compute(
      [message('m1', 1)],
      [
        row('n1', 'm1', { bindingId: 'other' }),
        row('n2', 'm1', { tier: 'ambient' }),
        row('n3', 'm1', { type: 'agent_request' }),
        row('n4', 'm1', { type: 'agent_waiting' }),
        row('n5', 'm1', { type: 'reaction' }),
        row('n6', null),
        row('n7', 'm1', { actor: { kind: 'user', userId: ME, name: 'Dylan', agent: null } }),
      ]
    );
    expect(forYou.asks).toEqual([]);
  });

  it('keeps an ask whose message is not loaded, and says so', () => {
    const forYou = compute([message('m9', 9)], [row('n1', 'old-msg', { messageSeq: 2 })]);
    expect(forYou.asks).toHaveLength(1);
    expect(forYou.asks[0]).toMatchObject({ messageId: 'old-msg', loaded: false, messageSeq: 2 });
    expect(forYou.messageIds.has('old-msg')).toBe(true);
  });

  it('does not depend on read state', () => {
    const forYou = compute(
      [message('m1', 1)],
      [row('n1', 'm1', { readAt: '2026-10-01T12:00:00Z' })]
    );
    expect(forYou.asks).toHaveLength(1);
  });

  it('counts one ask per message when the inbox has two rows for it, dismissed by either', () => {
    const rows = [row('n1', 'm1', { type: 'mention' }), row('n2', 'm1', { type: 'reply' })];
    const forYou = compute([message('m1', 1)], rows);
    expect(forYou.asks).toHaveLength(1);
    expect(forYou.asks[0]).toMatchObject({
      notificationId: 'n1',
      notificationIds: ['n1', 'n2'],
      type: 'mention',
    });
    expect(compute([message('m1', 1)], rows, { dismissed: ['n2'] }).asks).toEqual([]);
    expect(compute([message('m1', 1)], rows, { dismissed: ['n1'] }).asks).toEqual([]);
  });

  it('is handled by a later quote-reply from you', () => {
    const reply = message('m2', 2, {
      authorId: ME,
      meta: {
        kind: 'text',
        replyTo: { id: 'm1', authorId: 'maya', label: 'Maya', excerpt: 'hey' },
      },
    });
    expect(compute([message('m1', 1), reply], [row('n1', 'm1')]).asks).toEqual([]);
  });

  it('is handled by a quote-reply even when the asked message is out of the loaded window', () => {
    const reply = message('m5', 5, {
      authorId: ME,
      meta: {
        kind: 'text',
        replyTo: { id: 'old', authorId: 'maya', label: 'Maya', excerpt: 'hey' },
      },
    });
    expect(compute([reply], [row('n1', 'old')]).asks).toEqual([]);
  });

  it('is not handled by someone else replying, or a reply to another message', () => {
    const elseReply = message('m2', 2, {
      authorId: 'sam',
      meta: {
        kind: 'text',
        replyTo: { id: 'm1', authorId: 'maya', label: 'Maya', excerpt: 'hey' },
      },
    });
    const otherReply = message('m3', 3, {
      authorId: ME,
      meta: {
        kind: 'text',
        replyTo: { id: 'm0', authorId: 'maya', label: 'Maya', excerpt: 'hey' },
      },
    });
    expect(compute([message('m1', 1), elseReply, otherReply], [row('n1', 'm1')]).asks).toHaveLength(
      1
    );
  });

  it('is handled by a later message of yours in the same comment thread, not an earlier one', () => {
    const comment = (id: string, seq: number, authorId: string, extra: Partial<RoomMessage> = {}) =>
      message(id, seq, {
        authorId,
        threadId: 't1',
        meta: {
          kind: 'comment_mirror',
          commentId: 't1',
          path: 'a.md',
          quote: 'q',
          isReply: seq > 1,
        },
        ...extra,
      });
    const earlier = comment('t0', 0, ME);
    const root = comment('t1', 1, 'maya');
    const ask = row('n1', 't1', { type: 'comment' });
    expect(compute([earlier, root], [ask]).asks).toHaveLength(1);
    expect(compute([earlier, root, comment('t2', 2, ME)], [ask]).asks).toEqual([]);
    // Your agent answering in the thread is not you.
    const agentReply = comment('t3', 3, ME, {
      meta: {
        kind: 'comment_mirror',
        commentId: 't1',
        path: 'a.md',
        quote: 'q',
        isReply: true,
        replyFromAgent: 'claude',
      },
    });
    expect(compute([root, agentReply], [ask]).asks).toHaveLength(1);
  });

  it('a plain message of yours elsewhere does not handle it', () => {
    expect(
      compute([message('m1', 1), message('m2', 2, { authorId: ME })], [row('n1', 'm1')]).asks
    ).toHaveLength(1);
  });

  it('leaves for good when dismissed', () => {
    expect(compute([message('m1', 1)], [row('n1', 'm1')], { dismissed: ['n1'] }).asks).toEqual([]);
  });

  it('puts asks oldest first however the rows arrive', () => {
    const forYou = compute([message('a', 1), message('b', 2)], [row('n2', 'b'), row('n1', 'a')]);
    expect(forYou.asks.map((a) => a.messageId)).toEqual(['a', 'b']);
  });
});

function run(
  id: string,
  owner: string,
  startedMinute: number,
  status: SessionRunMeta['status'] = 'running'
): SessionRunMeta {
  return {
    id,
    agent: 'claude',
    owner,
    model: 'sonnet',
    title: '',
    status,
    startedAt: new Date(Date.UTC(2026, 9, 1, 10, startedMinute)).toISOString(),
    endedAt: null,
  };
}

function permissionEvents(...requestIds: string[]): SessionEvent[] {
  return requestIds.flatMap((requestId, i) => [
    {
      seq: i * 2 + 1,
      kind: 'tool_call',
      payload: {
        toolCallId: `t-${requestId}`,
        title: 'npm test',
        kind: 'execute',
        status: 'pending',
      },
    },
    {
      seq: i * 2 + 2,
      kind: 'permission_requested',
      payload: {
        requestId,
        toolCall: { toolCallId: `t-${requestId}`, title: 'npm test' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    },
  ]);
}

describe('computeForYou: approvals', () => {
  const sessionMessage = (id: string, seq: number, runId: string) =>
    message(id, seq, { authorId: ME, meta: { kind: 'session', runId } });

  it('lists only your own runs with pending requests, oldest first, with their session message', () => {
    const forYou = compute(
      [
        sessionMessage('s1', 1, 'r1'),
        sessionMessage('s2', 2, 'r2'),
        sessionMessage('s3', 3, 'r3'),
        sessionMessage('s4', 4, 'r4'),
      ],
      [],
      {
        snap: {
          sessionMetaByRun: {
            r1: run('r1', ME, 5),
            r2: run('r2', 'maya', 6),
            r3: run('r3', ME, 2),
            r4: run('r4', ME, 7),
          },
          sessionEventsByRun: {
            r1: permissionEvents('p1', 'p2'),
            r2: permissionEvents('px'), // someone else's agent
            r3: permissionEvents('p3'),
            r4: [], // nothing pending
          },
        },
      }
    );
    expect(forYou.approvals.map((a) => a.runId)).toEqual(['r3', 'r1']);
    expect(forYou.approvals[1]).toMatchObject({
      runId: 'r1',
      sessionMessageId: 's1',
      agent: 'claude',
      askedBy: { id: ME, name: 'Dylan' },
    });
    expect(forYou.approvals[1]!.pending.map((p) => p.requestId)).toEqual(['p1', 'p2']);
    expect(forYou.approvals[1]!.pending[0]!.options.map((o) => o.optionId)).toEqual([
      'allow',
      'reject',
    ]);
    expect(forYou.messageIds).toEqual(new Set(['s1', 's3']));
  });

  it('drops a request once it is answered, and a run that has ended', () => {
    const answered: SessionEvent[] = [
      ...permissionEvents('p1'),
      {
        seq: 9,
        kind: 'permission_decided',
        payload: { requestId: 'p1', toolCallId: 't-p1', optionId: 'allow', outcome: 'allowed' },
      },
    ];
    const msgs = [
      sessionMessage('s1', 1, 'r1'),
      sessionMessage('s2', 2, 'r2'),
      sessionMessage('s3', 3, 'r3'),
    ];
    const forYou = compute(msgs, [], {
      snap: {
        sessionMetaByRun: {
          r1: run('r1', ME, 1),
          r2: run('r2', ME, 2, 'done'),
          r3: run('r3', ME, 3),
        },
        sessionEventsByRun: {
          r1: answered,
          r2: permissionEvents('p2'),
          r3: [
            ...permissionEvents('p3'),
            { seq: 9, kind: 'turn_ended', payload: { status: 'stopped' } },
          ],
        },
      },
    });
    expect(forYou.approvals).toEqual([]);
  });

  it('says who asked when a request row names the run, else the owner', () => {
    const snap = {
      sessionMetaByRun: { r1: run('r1', ME, 1) },
      sessionEventsByRun: { r1: permissionEvents('p1') },
    };
    const asked = compute(
      [sessionMessage('s1', 1, 'r1')],
      [row('n1', null, { type: 'agent_request', runId: 'r1' })],
      { snap }
    );
    expect(asked.approvals[0]!.askedBy).toEqual({ id: 'maya', name: 'Maya' });
    const alone = compute([sessionMessage('s1', 1, 'r1')], [], { snap });
    expect(alone.approvals[0]!.askedBy).toEqual({ id: ME, name: 'Dylan' });
  });

  it('keeps an approval whose session message is not loaded, without a message id', () => {
    const forYou = compute([], [], {
      snap: {
        sessionMetaByRun: { r1: run('r1', ME, 1) },
        sessionEventsByRun: { r1: permissionEvents('p1') },
      },
    });
    expect(forYou.approvals[0]!.sessionMessageId).toBeNull();
    expect(forYou.messageIds.size).toBe(0);
  });
});

describe('themesWithForYou', () => {
  it('names the themes that hold an ask or an approval', () => {
    const themes = themesWithForYou(
      { messageIds: new Set(['m1', 's1', 'unthemed']) },
      { m1: { themeId: 'pricing' }, s1: { themeId: 'launch' }, other: { themeId: 'misc' } }
    );
    expect(themes).toEqual(new Set(['pricing', 'launch']));
  });

  it("counts a reply in a comment thread under the thread root's theme", () => {
    const messages = [
      message('root', 1, { threadId: 'c1' }),
      message('reply', 2, { threadId: 'c1' }),
      message('loose', 3),
    ];
    const themeOf = { root: { themeId: 'pricing' } };
    expect(themesWithForYou({ messageIds: new Set(['reply']) }, themeOf, messages)).toEqual(
      new Set(['pricing'])
    );
    // No Room to look the thread up in, or no thread: nothing to fall back to.
    expect(themesWithForYou({ messageIds: new Set(['reply']) }, themeOf)).toEqual(new Set());
    expect(themesWithForYou({ messageIds: new Set(['loose']) }, themeOf, messages)).toEqual(
      new Set()
    );
  });
});

describe('diffArrivals', () => {
  const base = () => compute([message('m1', 1)], [row('n1', 'm1')]);

  it('counts nothing on the first look, only filling the set', () => {
    const first = diffArrivals(null, base());
    expect(first.arrivals).toEqual([]);
    expect([...first.seen]).toEqual(['ask:m1']);
  });

  it('announces a new ask and a new pending request, once', () => {
    const snap = {
      sessionMetaByRun: { r1: run('r1', ME, 1) },
      sessionEventsByRun: { r1: permissionEvents('p1') },
    };
    const first = diffArrivals(null, compute([message('m1', 1)], [row('n1', 'm1')], { snap }));
    const later = compute(
      [message('m1', 1), message('m2', 2)],
      [row('n1', 'm1'), row('n2', 'm2')],
      { snap: { ...snap, sessionEventsByRun: { r1: permissionEvents('p1', 'p2') } } }
    );
    const next = diffArrivals(first.seen, later);
    expect(next.arrivals.map((a) => a.key)).toEqual(['ask:m2', 'approval:r1:p2']);
    expect(diffArrivals(next.seen, later).arrivals).toEqual([]);
  });

  it('does not announce an item again after it left and came back', () => {
    const first = diffArrivals(null, base());
    const gone = diffArrivals(
      first.seen,
      compute([message('m1', 1)], [row('n1', 'm1')], { dismissed: ['n1'] })
    );
    expect(gone.arrivals).toEqual([]);
    expect(diffArrivals(gone.seen, base()).arrivals).toEqual([]);
  });
});

describe('approval options', () => {
  const options = [
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  ];
  it('orders deny, always, then the one-off allow, as the card does', () => {
    expect(
      sortPermissionOptions([options[2]!, options[0]!, options[1]!]).map((o) => o.optionId)
    ).toEqual(['reject', 'always', 'allow']);
  });
  it('approves with the one-off allow and rejects with the deny', () => {
    expect(approveOption(options)?.optionId).toBe('allow');
    expect(rejectOption(options)?.optionId).toBe('reject');
  });
  it('falls back sensibly', () => {
    expect(approveOption([options[0]!, options[1]!])?.optionId).toBe('always');
    expect(approveOption([{ optionId: 'ok', name: 'OK', kind: 'allow_session' }])?.optionId).toBe(
      'ok'
    );
    expect(rejectOption([options[2]!])).toBeUndefined();
  });
});
