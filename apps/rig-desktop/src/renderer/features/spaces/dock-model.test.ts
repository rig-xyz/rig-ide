import { describe, expect, it } from 'vitest';
import {
  forYouLine,
  railAgents,
  railMembers,
  sameFocus,
  splitThemes,
  themeColor,
} from './dock-model';
import type { Approval, Ask } from './for-you';
import type { RoomTheme } from './themes';
import type { RoomMember, SessionRunMeta } from './types';

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
