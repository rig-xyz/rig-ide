import { describe, expect, it } from 'vitest';
import {
  dockTasks,
  placeTasks,
  forYouLine,
  railAgents,
  railMembers,
  sameFocus,
  sameWho,
  splitThemes,
  spotlightFocus,
  themeColor,
  whoMessageIds,
  whoName,
} from './dock-model';
import type { Approval, Ask } from './for-you';
import type { RoomTheme, RoomThemes } from './themes';
import type { RoomMember, RoomMessage, SessionEvent, SessionRunMeta } from './types';

const theme = (id: string, count: number, lastSeq: number): RoomTheme => ({
  id,
  name: id,
  description: '',
  bornSeq: 1,
  count,
  lastSeq,
});

describe('themeColor', () => {
  it('gives the same slot to the same theme every time, one of eight', () => {
    expect(themeColor('theme-a')).toBe(themeColor('theme-a'));
    const slots = new Set(Array.from({ length: 60 }, (_, i) => themeColor(`theme-${i}`)));
    expect(slots.size).toBeGreaterThan(4);
    for (const slot of slots) expect(slot).toMatch(/^var\(--theme-[1-8]\)$/);
  });
});

describe('splitThemes', () => {
  it('orders by last activity, hides empty themes, shows six and keeps the rest', () => {
    const themes = Array.from({ length: 9 }, (_, i) => theme(`t${i}`, i === 3 ? 0 : 1, i + 1));
    const { shown, rest } = splitThemes(themes, []);
    expect(shown.map((t) => t.id)).toEqual(['t8', 't7', 't6', 't5', 't4', 't2']);
    expect(rest.map((t) => t.id)).toEqual(['t1', 't0']);
  });

  it('moves a theme quiet for 60 messages behind "+N"', () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 }));
    const { shown, rest } = splitThemes(
      [theme('busy', 2, 100), theme('recent', 2, 41), theme('quiet', 2, 40)],
      messages
    );
    expect(shown.map((t) => t.id)).toEqual(['busy', 'recent']);
    expect(rest.map((t) => t.id)).toEqual(['quiet']);
  });

  it('brings a focused theme from behind "+N" into the pills', () => {
    const themes = Array.from({ length: 8 }, (_, i) => theme(`t${i}`, 1, i + 1));
    const { shown, rest } = splitThemes(themes, [], 't0');
    expect(shown).toHaveLength(6);
    expect(shown.map((t) => t.id)).toContain('t0');
    expect(rest).toHaveLength(2);
  });
});

describe('forYouLine', () => {
  const ask = (name: string | null): Ask =>
    ({ actor: { kind: 'user', userId: name, name, agent: null } }) as Ask;
  const approval = (agent: 'claude' | 'codex', pending: number): Approval =>
    ({ agent, pending: Array.from({ length: pending }, () => ({})) }) as Approval;

  it('names who asked and what waits on your agent', () => {
    expect(
      forYouLine({ asks: [ask('Maya')], approvals: [approval('claude', 3), approval('claude', 0)] })
    ).toBe('Maya asked you directly. Your Claude has 3 approvals waiting in 2 runs.');
  });
  it('joins several names, and says approval in the singular', () => {
    expect(forYouLine({ asks: [ask('Maya'), ask('Sam')], approvals: [] })).toBe(
      'Maya and Sam asked you directly.'
    );
    expect(forYouLine({ asks: [ask('A'), ask('B'), ask('C'), ask(null)], approvals: [] })).toBe(
      'A, B and 2 more asked you directly.'
    );
    expect(forYouLine({ asks: [], approvals: [approval('codex', 1)] })).toBe(
      'Your Codex has 1 approval waiting.'
    );
    expect(forYouLine({ asks: [], approvals: [approval('codex', 1), approval('claude', 1)] })).toBe(
      'Your agents have 2 approvals waiting in 2 runs.'
    );
  });
  it('says so when nothing waits', () => {
    expect(forYouLine({ asks: [], approvals: [] })).toBe('Nothing is waiting on you.');
  });
});

describe('the rail', () => {
  const member = (id: string, extra: Partial<RoomMember> = {}): RoomMember => ({
    id,
    name: id,
    email: '',
    role: '',
    initial: id[0]!,
    status: 'here',
    ...extra,
  });

  it('shows everyone but the invited: typing first, then present, then away, by name in each group', () => {
    const members = [
      member('zed'),
      member('me', { name: 'Dylan' }),
      member('bo', { name: 'Bo', online: false }),
      member('al', { name: 'Al' }),
      member('cy', { name: 'Cy' }),
      member('inv', { status: 'invited' }),
    ];
    const { shown, more } = railMembers({ members, typingUserIds: ['cy'] }, 'me');
    expect(shown.map((m) => `${m.member.name}:${m.present ? 'here' : 'away'}:${m.typing}`)).toEqual([
      'Cy:here:true',
      'Al:here:false',
      'Dylan:here:false',
      'zed:here:false',
      'Bo:away:false',
    ]);
    expect(more).toBe(0);
  });

  it('shows six people at most and counts the rest', () => {
    const members = Array.from({ length: 9 }, (_, i) => member(`p${i}`));
    const { shown, more } = railMembers({ members, typingUserIds: [] }, 'p0');
    expect(shown).toHaveLength(6);
    expect(more).toBe(3);
  });

  it('shows every agent that has run, running ones first, three at most', () => {
    const run = (
      id: string,
      owner: string,
      agent: 'claude' | 'codex',
      startedAt: string,
      status: SessionRunMeta['status'] = 'done'
    ): SessionRunMeta => ({
      id,
      owner,
      agent,
      model: 'x',
      title: '',
      status,
      startedAt,
      endedAt: null,
    });
    const snapshot = {
      sessionMetaByRun: {
        a: run('a', 'me', 'claude', '2026-10-01T10:00:00Z'),
        b: run('b', 'me', 'codex', '2026-10-01T09:00:00Z'),
        c: run('c', 'sam', 'claude', '2026-10-01T09:30:00Z'),
        d: run('d', 'maya', 'claude', '2026-10-01T08:00:00Z', 'running'),
        old: run('old', 'ola', 'claude', '2026-09-01T08:00:00Z'),
      },
      sessionEventsByRun: {},
    };
    const { shown, more } = railAgents(snapshot, 'me');
    // Maya's is running (full strength, first); then yours, newest first; Sam's and Ola's are behind "+N".
    expect(shown.map((a) => `${a.owner}:${a.agent}:${a.active}`)).toEqual([
      'maya:claude:true',
      'me:claude:false',
      'me:codex:false',
    ]);
    expect(more).toBe(2);
  });
});

describe('sameFocus', () => {
  it('compares kind and theme', () => {
    expect(sameFocus(null, null)).toBe(true);
    expect(sameFocus({ kind: 'for-you' }, { kind: 'for-you' })).toBe(true);
    expect(sameFocus({ kind: 'theme', themeId: 'a' }, { kind: 'theme', themeId: 'a' })).toBe(true);
    expect(sameFocus({ kind: 'theme', themeId: 'a' }, { kind: 'theme', themeId: 'b' })).toBe(false);
    expect(sameFocus({ kind: 'for-you' }, null)).toBe(false);
  });
});

// ────────── spotlight ──────────

const message = (id: string, authorId: string, meta: RoomMessage['meta'] = { kind: 'text' }): RoomMessage => ({
  id,
  seq: 0,
  authorId,
  createdAt: '2026-10-01T10:00:00Z',
  time: '10:00',
  meta,
});

const runMeta = (
  id: string,
  owner: string,
  agent: 'claude' | 'codex',
  extra: Partial<SessionRunMeta> = {}
): SessionRunMeta => ({
  id,
  owner,
  agent,
  model: 'x',
  title: `Task ${id}`,
  status: 'running',
  startedAt: '2026-10-01T10:00:00Z',
  endedAt: null,
  ...extra,
});

describe('sameWho', () => {
  it('compares a person by id and an agent by owner and kind', () => {
    expect(sameWho(null, null)).toBe(true);
    expect(sameWho({ kind: 'person', userId: 'a' }, { kind: 'person', userId: 'a' })).toBe(true);
    expect(sameWho({ kind: 'person', userId: 'a' }, { kind: 'person', userId: 'b' })).toBe(false);
    const claude = { kind: 'agent', owner: 'a', agent: 'claude' } as const;
    expect(sameWho(claude, { ...claude })).toBe(true);
    expect(sameWho(claude, { ...claude, agent: 'codex' })).toBe(false);
    expect(sameWho(claude, { kind: 'person', userId: 'a' })).toBe(false);
    expect(sameWho(claude, null)).toBe(false);
  });
});

describe('whoMessageIds', () => {
  const snapshot = {
    messages: [
      message('sam-1', 'sam'),
      message('maya-ask', 'maya'),
      message('maya-run', 'maya', { kind: 'session', runId: 'r1', sourceMessageId: 'maya-ask' }),
      message('maya-codex', 'maya', { kind: 'session', runId: 'r2' }),
      message('maya-reply', 'maya', {
        kind: 'comment_mirror',
        commentId: 'c',
        path: 'a.md',
        quote: '',
        replyFromAgent: 'claude',
      }),
      message('sam-2', 'sam'),
    ],
    sessionMetaByRun: { r1: runMeta('r1', 'maya', 'claude'), r2: runMeta('r2', 'maya', 'codex') },
  };

  it("keeps a person's own messages and every run of their agents", () => {
    expect([...whoMessageIds(snapshot, { kind: 'person', userId: 'sam' })]).toEqual(['sam-1', 'sam-2']);
    expect([...whoMessageIds(snapshot, { kind: 'person', userId: 'maya' })]).toEqual([
      'maya-ask',
      'maya-run',
      'maya-codex',
      'maya-reply',
    ]);
  });

  it("keeps an agent's runs, the asks that started them and its doc replies, and not its owner's other agent", () => {
    expect([...whoMessageIds(snapshot, { kind: 'agent', owner: 'maya', agent: 'claude' })].sort()).toEqual([
      'maya-ask',
      'maya-reply',
      'maya-run',
    ]);
    expect([...whoMessageIds(snapshot, { kind: 'agent', owner: 'maya', agent: 'codex' })]).toEqual([
      'maya-codex',
    ]);
  });
});

describe('whoName', () => {
  const snapshot = {
    members: [{ id: 'sam', name: 'Sam', email: '', role: 'editor', initial: 'S', status: 'here' }] as RoomMember[],
    messages: [],
  };
  it('says You, a name, or whose agent', () => {
    expect(whoName(snapshot, { kind: 'person', userId: 'me' }, 'me')).toBe('You');
    expect(whoName(snapshot, { kind: 'person', userId: 'sam' }, 'me')).toBe('Sam');
    expect(whoName(snapshot, { kind: 'agent', owner: 'me', agent: 'claude' }, 'me')).toBe('Your Claude');
    expect(whoName(snapshot, { kind: 'agent', owner: 'sam', agent: 'codex' }, 'me')).toBe("Sam's Codex");
  });
});

describe('spotlightFocus', () => {
  const sam = { who: { kind: 'person', userId: 'sam' } as const, messageIds: new Set(['a', 'b', 'c']) };

  it('is the topic as it is without a face, and the face alone without a topic', () => {
    const topic = { messageIds: new Set(['a']), key: 't', foldLabel: () => '' };
    expect(spotlightFocus(topic, null, false)).toBe(topic);
    expect(spotlightFocus(undefined, null, false)).toBeUndefined();
    const alone = spotlightFocus(undefined, sam, false)!;
    expect([...alone.messageIds]).toEqual(['a', 'b', 'c']);
    expect(alone.key).toBe('person:sam');
    expect(alone.foldLabel(1)).toBe('1 message from others');
    expect(alone.foldLabel(3)).toBe('3 messages from others');
  });

  it('keeps what is in both a topic and the face, and says why the rest is folded', () => {
    const topic = { messageIds: new Set(['b', 'c', 'd']), key: 'pricing', foldLabel: () => '' };
    const both = spotlightFocus(topic, sam, false)!;
    expect([...both.messageIds]).toEqual(['b', 'c']);
    expect(both.key).toBe('pricing|person:sam');
    expect(both.foldLabel(2)).toBe('2 messages from others or in other topics');
  });

  it('narrows For you and its asks to the face too', () => {
    const forYou = {
      messageIds: new Set(['a', 'd']),
      askIds: new Set(['a', 'd']),
      order: 'asks-first' as const,
      key: 'for-you',
      foldLabel: () => '',
    };
    const both = spotlightFocus(forYou, sam, true)!;
    expect([...both.messageIds]).toEqual(['a']);
    expect([...both.askIds!]).toEqual(['a']);
    expect(both.order).toBe('asks-first');
    expect(both.foldLabel(1)).toBe('1 message from others or not waiting on you');
  });
});

// ────────── tasks in progress ──────────

describe('dockTasks', () => {
  const NOW = Date.parse('2026-10-01T10:10:00Z');
  const themes: RoomThemes = {
    enabled: true,
    list: [{ id: 'launch', name: 'Launch', description: '', bornSeq: 1, count: 2, lastSeq: 2 }],
    themeOf: { s1: { themeId: 'launch', via: 'jev' }, ask3: { themeId: 'launch', via: 'jev' } },
    cursor: '1',
  };
  const step = (kind: string, title: string): SessionEvent[] => [
    { seq: 1, kind: 'tool_call', payload: { toolCallId: 't', title, kind, status: 'in_progress' } },
  ];
  const approval: SessionEvent[] = [
    { seq: 1, kind: 'tool_call', payload: { toolCallId: 't', title: 'Run tests', kind: 'execute', status: 'pending' } },
    {
      seq: 2,
      kind: 'permission_requested',
      payload: { requestId: 'p', toolCall: { toolCallId: 't', title: 'Run tests' }, options: [] },
    },
  ];
  const snapshot = {
    members: [{ id: 'sam', name: 'Sam', email: '', role: 'editor', initial: 'S', status: 'here' }] as RoomMember[],
    messages: [
      message('s1', 'me', { kind: 'session', runId: 'r1' }),
      message('s2', 'sam', { kind: 'session', runId: 'r2' }),
      message('s3', 'sam', { kind: 'session', runId: 'r3', sourceMessageId: 'ask3' }),
      message('s4', 'me', { kind: 'session', runId: 'r4' }),
      message('s5', 'me', { kind: 'session', runId: 'r5' }),
    ],
    sessionMetaByRun: {
      r1: runMeta('r1', 'me', 'claude', { startedAt: '2026-10-01T10:07:30Z' }),
      r2: runMeta('r2', 'sam', 'codex', { startedAt: '2026-10-01T10:05:00Z' }),
      r3: runMeta('r3', 'sam', 'claude', {
        status: 'done',
        startedAt: '2026-10-01T10:01:00Z',
        endedAt: '2026-10-01T10:08:00Z',
      }),
      r4: runMeta('r4', 'me', 'codex', {
        status: 'done',
        startedAt: '2026-09-30T10:00:00Z',
        endedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      }),
      r5: runMeta('r5', 'me', 'codex', {
        status: 'failed',
        startedAt: '2026-10-01T10:09:00Z',
        endedAt: '2026-10-01T10:09:30Z',
      }),
    },
    sessionEventsByRun: { r1: step('read', 'Read notes.md'), r2: approval },
  };

  // r4 finished and was seen; r3 and r5 finished and weren't, however long ago.
  const seenOnly = (...ids: string[]) => (run: { runId: string }) => ids.includes(run.runId);

  it('lists running, waiting and finished runs not yet seen, oldest first, and drops seen ones', () => {
    const tasks = dockTasks(snapshot, themes, 'me', NOW, seenOnly('r4'));
    expect(tasks.map((t) => `${t.runId}:${t.state}`)).toEqual([
      'r3:done',
      'r2:waiting',
      'r1:working',
      'r5:done',
    ]);
  });

  it('keeps a finished run that was never seen, however long ago it ended, and asks with its seq and end', () => {
    const asked: unknown[] = [];
    const tasks = dockTasks(snapshot, themes, 'me', NOW, (run) => {
      asked.push(run);
      return false;
    });
    expect(tasks.map((t) => t.runId)).toContain('r4');
    expect(asked).toContainEqual({ runId: 'r3', seq: snapshot.messages[2]!.seq, endedAt: Date.parse('2026-10-01T10:08:00Z') });
    // A running one is never asked about.
    expect(asked.some((r) => (r as { runId: string }).runId === 'r1')).toBe(false);
  });

  it('says what each is doing, with its dot matrix and time', () => {
    const byId = Object.fromEntries(dockTasks(snapshot, themes, 'me', NOW, seenOnly('r4')).map((t) => [t.runId, t]));
    expect(byId.r1).toMatchObject({ matrix: 'reading', step: 'Read notes.md', status: '2m 30s', own: true });
    expect(byId.r2).toMatchObject({ matrix: 'waiting', step: 'Waiting on Sam', status: 'Waiting on Sam' });
    expect(byId.r3).toMatchObject({ matrix: 'done', status: 'Done' });
    expect(byId.r5).toMatchObject({ matrix: 'failed', status: 'Failed' });
  });

  it('places a task under the topic of its run or its ask, and none while the relay holds both', () => {
    const byId = Object.fromEntries(dockTasks(snapshot, themes, 'me', NOW, seenOnly('r4')).map((t) => [t.runId, t]));
    expect(byId.r1!.themeId).toBe('launch');
    expect(byId.r3!.themeId).toBe('launch');
    expect(byId.r2!.themeId).toBeNull();
    expect(dockTasks(snapshot, null, 'me', NOW, seenOnly('r4')).every((t) => t.themeId === null)).toBe(true);
  });

  it("hides the step of someone else's run whose details the Room only sees as an answer", () => {
    const hidden = {
      ...snapshot,
      sessionEventsByRun: {
        r2: [
          { seq: 1, kind: 'run_privacy', payload: { level: 'answer' } },
          ...step('read', 'Read secrets.md').map((e) => ({ ...e, seq: 2 })),
        ],
      },
    };
    const r2 = dockTasks(hidden, themes, 'me', NOW, seenOnly('r4')).find((t) => t.runId === 'r2')!;
    expect(r2.step).not.toContain('secrets');
  });
});

describe('placeTasks', () => {
  const task = (runId: string, themeId: string | null) =>
    ({ runId, messageId: `m-${runId}`, agent: 'claude', owner: 'me', own: true, title: runId, state: 'working', matrix: 'thinking', step: '', status: '1m', themeId }) as const;

  it('hangs a task under its shown topic, under "Not sorted yet" without one, and under "+N" when its topic is folded', () => {
    const tasks = [task('a', 'launch'), task('b', null), task('c', 'old'), task('d', 'launch'), task('e', 'older')];
    const { unsorted, underTheme, folded } = placeTasks(tasks, new Set(['launch', 'pricing']));
    expect(unsorted.map((t) => t.runId)).toEqual(['b']);
    expect([...underTheme.entries()].map(([id, list]) => [id, list.map((t) => t.runId)])).toEqual([['launch', ['a', 'd']]]);
    expect(folded.map((t) => t.runId)).toEqual(['c', 'e']);
  });

  it('leaves no task out, whatever is shown', () => {
    const tasks = [task('a', 'launch'), task('b', null), task('c', 'old')];
    const { unsorted, underTheme, folded } = placeTasks(tasks, new Set());
    expect(unsorted.length + [...underTheme.values()].flat().length + folded.length).toBe(tasks.length);
  });
});
