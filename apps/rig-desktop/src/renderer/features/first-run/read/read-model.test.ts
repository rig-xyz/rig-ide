import { describe, expect, it } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import { initialRead, progressOf, readReducer, tickerLines } from './read-model';

const run = 'run_1';
const line = (
  id: string,
  connector: string | null,
  label: string,
  status: 'running' | 'done' | 'handled' | 'not_yours' | 'for_you',
  t: number,
  ref?: string
): OrchProgressEvent => ({
  run,
  kind: 'line',
  line: { id, connector, label, status, t, ...(ref ? { ref } : {}) },
});

const play = (events: OrchProgressEvent[]) => events.reduce(readReducer, initialRead);

describe('the Read step model', () => {
  const events: OrchProgressEvent[] = [
    { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 },
    line('step:state', null, 'Looking up what Rig already knows', 'running', 5),
    line('step:state', null, 'Looking up what Rig already knows', 'done', 300),
    { run, kind: 'pass', pass: 1, lookups: 12, goal: 'first card', lookbackDays: 3, t: 2500 },
    line('t1', 'slack', 'Reading #eng', 'running', 4000),
    line('t1', 'slack', 'Reading #eng', 'done', 4600),
    line('t2', 'rig', 'Looking at what Rig knows', 'done', 5000),
    line(
      'outcome:n1',
      'slack',
      'Payout delay: Sam resolved it Tuesday',
      'handled',
      6000,
      'msg:slack:C1:1'
    ),
    line(
      'outcome:n2',
      'github',
      '5 Dependabot PRs: the platform team merges these',
      'not_yours',
      6500
    ),
    line(
      'outcome:n3',
      'linear',
      'LAR-91: High, unassigned, nobody on it',
      'for_you',
      7000,
      'sit_9'
    ),
    { run, kind: 'card', ref: 'sit_9', t: 7100 },
    { run: 'run_other', kind: 'card', ref: 'sit_elsewhere', t: 7200 },
  ];

  it('counts every lookup that read something, what was already handled, and what is for you once', () => {
    const s = play(events);
    // Rig's own records are its memory, not a lookup in the person's tools: only the Slack read counts.
    expect(s.counts).toEqual({ read: 1, handled: 2, forYou: 1 });
    expect(s.cards).toEqual(['sit_9']);
    expect(s.firstLineAt).toBe(5);
    expect(s.firstCardAt).toBe(7100);
  });

  it('measures progress in lookups against the budget, full only at the end', () => {
    const s = play(events);
    expect(s.lookups).toEqual({ used: 2, budget: 52 });
    expect(progressOf(s)).toBeCloseTo(2 / 52);
    // A widened pass past the planned two adds its budget.
    expect(
      readReducer(s, {
        run,
        kind: 'pass',
        pass: 3,
        lookups: 12,
        goal: null,
        lookbackDays: 14,
        t: 8000,
      }).lookups.budget
    ).toBe(64);
    expect(progressOf(readReducer(s, { run, kind: 'end', ok: true, t: 9000 }))).toBe(1);
  });

  it("keeps Rig's own lookups off the ticker, and replaces a line as it settles", () => {
    const labels = tickerLines(play(events)).map((l) => `${l.label}:${l.status}`);
    expect(labels).toContain('Reading #eng:done');
    expect(labels).not.toContain('Looking at what Rig knows:done');
    expect(labels.filter((l) => l.startsWith('Reading #eng'))).toHaveLength(1);
  });

  it('starts over on a new run', () => {
    const s = readReducer(play(events), {
      run: 'run_2',
      kind: 'start',
      trigger: 'first',
      passes: 2,
      lookups: 52,
      lookbackDays: 3,
      t: 0,
    });
    expect(s.lines).toEqual([]);
    expect(s.run).toBe('run_2');
  });
});

describe('a catch-up', () => {
  it('counts as new only the cards it put that were not on the Feed, whatever its outcomes name', () => {
    const run = 'r';
    const events: OrchProgressEvent[] = [
      { run, kind: 'start', trigger: 'catch-up', passes: 1, lookups: 20, lookbackDays: 3, since: '2026-10-27T04:53:04.000Z', t: 0 },
      { run, kind: 'line', line: { id: 'o1', connector: 'slack', label: 'Natalie still waits; card stays', status: 'for_you', ref: 'msg:slack:C0:1.2', t: 1 } },
      { run, kind: 'line', line: { id: 'o2', connector: null, label: 'Riyad waits on your review', status: 'for_you', ref: 'sit_new', t: 2 } },
      { run, kind: 'card', ref: 'sit_new', fresh: true, t: 3 },
      { run, kind: 'card', ref: 'sit_old', fresh: false, t: 4 },
    ];
    const state = events.reduce(readReducer, initialRead);
    expect(state.counts.forYou).toBe(1);
    expect(state.since).toBe('2026-10-27T04:53:04.000Z');
  });
});
