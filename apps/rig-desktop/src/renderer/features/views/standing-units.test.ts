import { describe, expect, it } from 'vitest';
import type { SpaceRun, SpaceState, ViewWork } from '@shared/rig/space-state';
import type { ViewManifest } from '@shared/rig/views';
import { fitStandingUnits, standingUnits, unitLabel, type StandingUnit } from './standing-units';

const MIN = 60_000;
const H = 60 * MIN;
const at = (h: number, m = 0, day = 13) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(14, 0);

const manifest = (over: Partial<ViewManifest> = {}): ViewManifest => ({
  name: 'bugs',
  kind: 'board',
  icon: null,
  order: null,
  title: 'Bug fixes',
  sub: null,
  counts: null,
  failed: false,
  note: null,
  updatedMs: NOW - 5 * MIN,
  every: '1h',
  everyMs: H,
  ...over,
});
const work = (over: Partial<ViewWork> = {}): ViewWork => ({
  view: 'bugs',
  everyMs: H,
  runsAs: 'usr_me',
  runsHere: true,
  needsAccept: false,
  dataModifiedMs: NOW - 5 * MIN,
  refreshingRunId: null,
  lastRefresh: null,
  nextDueAt: at(15),
  skipped: null,
  ...over,
});
const run = (over: Partial<SpaceRun> = {}): SpaceRun => ({
  runId: 'r1',
  startedBy: 'clock',
  view: 'bugs',
  ownerUserId: 'usr_me',
  agent: 'claude',
  startedAt: NOW - MIN,
  state: 'working',
  step: 'Reading FACTORY.md',
  stepKind: 'reading',
  lastEventAt: NOW,
  endedAt: null,
  ...over,
});
const state = (over: Partial<SpaceState> = {}): SpaceState => ({
  bindingId: 'b1',
  at: NOW,
  views: [work()],
  runs: [],
  ...over,
});
const units = (over: Partial<Parameters<typeof standingUnits>[0]> = {}) =>
  standingUnits({
    views: [manifest()],
    state: state(),
    agentName: { claude: 'Claude', codex: 'Codex' },
    viewTurns: [],
    justScheduled: new Set(),
    members: [],
    now: NOW,
    ...over,
  });

describe('standingUnits', () => {
  it('a scheduled view at rest says when it runs, and opens its view', () => {
    expect(units()).toEqual([
      {
        key: 'view:bugs',
        name: 'Bug fixes',
        line: 'Every hour · in 1 h, at 15:00',
        tone: undefined,
        matrix: 'standby',
        matrixTone: 'mute',
        arrived: undefined,
        view: 'bugs',
      },
    ]);
  });

  it('a view with no schedule and nothing going is a tab, not a loop: it has no unit', () => {
    const none = units({
      views: [manifest({ every: null, everyMs: null, updatedMs: NOW - 21 * H })],
      state: state({ views: [] }),
    });
    expect(none).toEqual([]);
  });

  it("Rig's own look over the space stands at rest once it has looked, and says when", () => {
    const all = units({
      views: [],
      state: { ...state({ views: [] }), check: { lastStartedAt: NOW - 21 * MIN, lastFinishedAt: NOW - 20 * MIN } },
    });
    expect(all.map(unitLabel)).toEqual([
      'Rig looks after this space · Keeping your tabs and facts up to date · last looked 20 min ago',
    ]);
    expect(all[0]).toMatchObject({ matrix: 'standby', matrixTone: 'mute', view: null });
  });

  it('a scheduled refresh shows on its view, not as a second unit', () => {
    const all = units({ state: state({ runs: [run()] }) });
    expect(all).toHaveLength(1);
    expect(unitLabel(all[0]!)).toBe('Bug fixes · Refreshing · Reading FACTORY.md');
    expect(all[0]!.matrix).toBe('reading');
  });

  it('a scheduled view with a problem says the problem, not the schedule', () => {
    const [unit] = units({
      state: state({
        views: [
          work({
            lastRefresh: {
              startedAt: at(13),
              finishedAt: at(13, 5),
              startedBy: 'clock',
              result: 'failed',
            },
            dataModifiedMs: at(12),
          }),
        ],
      }),
    });
    expect(unit).toMatchObject({
      line: 'Refresh failed at 13:05, next try at 15:00',
      tone: 'bad',
      matrix: 'failed',
    });
  });

  it("Rig's own look over the space is a unit with no view", () => {
    const all = units({
      state: state({ runs: [run({ runId: 'g1', startedBy: 'gardener', view: null })] }),
    });
    expect(all.map((unit) => unit.key)).toEqual(['view:bugs', 'run:g1']);
    expect(unitLabel(all[1]!)).toBe(
      'Rig is looking after this space · Reading FACTORY.md'
    );
    expect(all[1]!.view).toBeNull();
  });

  it('a choice in a view with no schedule shows on that view', () => {
    const all = units({
      views: [
        manifest(),
        manifest({ name: 'drafts', title: 'Drafts', every: null, everyMs: null }),
      ],
      state: state({
        runs: [
          run({ runId: 'v1', startedBy: 'view', view: 'drafts', step: '', stepKind: 'thinking' }),
        ],
      }),
    });
    expect(all.map((unit) => unit.key)).toEqual(['view:bugs', 'view:drafts']);
    expect(unitLabel(all[1]!)).toBe('Drafts · Working on it');
    expect(all[1]!.matrix).toBe('thinking');
  });

  it('two agents working are two units, oldest first; ended runs are none', () => {
    const all = units({
      views: [],
      state: state({
        views: [],
        runs: [
          run({
            runId: 'b',
            startedBy: 'message',
            view: null,
            agent: 'codex',
            startedAt: NOW - MIN,
          }),
          run({ runId: 'a', startedBy: 'message', view: null, startedAt: NOW - 2 * MIN }),
          run({ runId: 'c', startedBy: 'message', view: null, state: 'done', endedAt: NOW }),
        ],
      }),
    });
    expect(all.map((unit) => unit.key)).toEqual(['run:a', 'run:b']);
    expect(all.map((unit) => unit.name)).toEqual(['Claude is replying', 'Codex is replying']);
  });

  it('a pass waiting on the person says so, in the warning tone', () => {
    const [unit] = units({
      views: [],
      state: state({
        views: [],
        runs: [run({ startedBy: 'message', view: null, state: 'waiting' })],
      }),
    });
    expect(unit).toMatchObject({
      name: 'Claude needs you',
      matrix: 'waiting',
      matrixTone: 'warn',
    });
  });

  it('nothing known yet: scheduled views still stand, from their manifests alone', () => {
    expect(units({ state: null }).map(unitLabel)).toEqual([
      'Bug fixes · Every hour, while Rig is open',
    ]);
  });
});

describe('fitStandingUnits', () => {
  const unit = (key: string, over: Partial<StandingUnit> = {}): StandingUnit => ({
    key,
    name: key,
    matrix: 'queued',
    view: null,
    ...over,
  });

  it('shows them all when they fit', () => {
    const all = [unit('a'), unit('b')];
    expect(fitStandingUnits(all, 2)).toEqual({ shown: all, more: [] });
  });

  it('keeps the order, and never leaves out one that waits on the person or failed', () => {
    const all = [
      unit('a'),
      unit('b'),
      unit('c', { matrix: 'waiting', matrixTone: 'warn' }),
      unit('d', { matrix: 'failed', tone: 'bad' }),
    ];
    const { shown, more } = fitStandingUnits(all, 3);
    expect(shown.map((u) => u.key)).toEqual(['a', 'c', 'd']);
    expect(more.map((u) => u.key)).toEqual(['b']);
  });
});
