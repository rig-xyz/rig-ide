import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from '@shared/rig/home-layout';
import {
  buildSpaceSections,
  isQuiet,
  nextGroupName,
  QUIET_AFTER_MS,
  type SpaceSignals,
  type SpaceSectionsInput,
} from './space-sections';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

type Row = { bindingId: string; name: string };
const row = (bindingId: string, name = bindingId): Row => ({ bindingId, name });

const sig = (over: Partial<SpaceSignals> = {}): SpaceSignals => ({
  needsYou: false,
  live: false,
  lastActivityAt: NOW - DAY,
  known: true,
  ...over,
});

function input(over: Partial<SpaceSectionsInput<Row>> & { rows: Row[] }): SpaceSectionsInput<Row> {
  return {
    layout: DEFAULT_HOME_LAYOUT,
    signals: new Map(over.rows.map((r) => [r.bindingId, sig()])),
    pinned: new Set(),
    // The given row order stands for the "recent activity" order.
    recentOrder: new Map(over.rows.map((r, i) => [r.bindingId, i])),
    now: NOW,
    ...over,
  };
}

const ids = (rows: Row[]) => rows.map((r) => r.bindingId);
const shape = (view: ReturnType<typeof buildSpaceSections<Row>>) =>
  view.sections.filter((s) => s.visible).map((s) => [s.title, ids(s.rows)]);

describe('isQuiet', () => {
  it('is nothing new in 14 days, never for a space that needs you or is live, never before status is known', () => {
    expect(isQuiet(sig({ lastActivityAt: NOW - QUIET_AFTER_MS - 1 }), NOW)).toBe(true);
    expect(isQuiet(sig({ lastActivityAt: NOW - QUIET_AFTER_MS + 1 }), NOW)).toBe(false);
    expect(isQuiet(sig({ lastActivityAt: null }), NOW)).toBe(true);
    expect(isQuiet(sig({ lastActivityAt: null, needsYou: true }), NOW)).toBe(false);
    expect(isQuiet(sig({ lastActivityAt: null, live: true }), NOW)).toBe(false);
    expect(isQuiet(sig({ lastActivityAt: null, known: false }), NOW)).toBe(false);
    expect(isQuiet(undefined, NOW)).toBe(false);
  });
});

describe('buildSpaceSections — custom groups', () => {
  const layout: HomeLayout = {
    ...DEFAULT_HOME_LAYOUT,
    groups: [
      { id: 'g1', name: 'Launch', collapsed: false, spaces: ['b', 'gone'] },
      { id: 'g2', name: 'Ops', collapsed: true, spaces: ['c'] },
      { id: 'g3', name: 'Empty', collapsed: false, spaces: ['also-gone'] },
    ],
  };

  it("puts each group in order, then Ungrouped last; a space you left just isn't there", () => {
    const view = buildSpaceSections(
      input({ rows: [row('a'), row('b'), row('c'), row('d')], layout })
    );
    expect(shape(view)).toEqual([
      ['Launch', ['b']],
      ['Ops', ['c']],
      ['Ungrouped', ['a', 'd']],
    ]);
    expect(view.sections.find((s) => s.key === 'g2')!.collapsed).toBe(true);
  });

  it('hides an empty group unless "Show empty groups", or it was just made here', () => {
    const rows = [row('a'), row('b'), row('c')];
    expect(
      buildSpaceSections(input({ rows, layout })).sections.find((s) => s.key === 'g3')!.visible
    ).toBe(false);
    expect(
      buildSpaceSections(
        input({ rows, layout: { ...layout, showEmptyGroups: true } })
      ).sections.find((s) => s.key === 'g3')!.visible
    ).toBe(true);
    expect(
      buildSpaceSections(input({ rows, layout, keepVisible: new Set(['g3']) })).sections.find(
        (s) => s.key === 'g3'
      )!.visible
    ).toBe(true);
  });

  it('with no groups yet, is one list with no header', () => {
    const view = buildSpaceSections(input({ rows: [row('a'), row('b')] }));
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]).toMatchObject({ kind: 'all', title: null });
  });

  it('remembers Ungrouped collapsed', () => {
    const view = buildSpaceSections(
      input({ rows: [row('a')], layout: { ...layout, collapsed: ['ungrouped'] } })
    );
    expect(view.sections.find((s) => s.key === 'ungrouped')).toMatchObject({ collapsed: true });
  });
});

describe('buildSpaceSections — state and none', () => {
  const rows = [row('quiet'), row('calm'), row('ask'), row('live')];
  const signals = new Map([
    ['quiet', sig({ lastActivityAt: NOW - 30 * DAY })],
    ['calm', sig({ lastActivityAt: NOW - 2 * DAY })],
    ['ask', sig({ needsYou: true, lastActivityAt: NOW - 40 * DAY })],
    ['live', sig({ live: true, lastActivityAt: NOW - 20 * DAY })],
  ]);

  it('state: Needs you, Active, Quiet', () => {
    const view = buildSpaceSections(
      input({ rows, signals, layout: { ...DEFAULT_HOME_LAYOUT, groupBy: 'state' } })
    );
    expect(shape(view)).toEqual([
      ['Needs you', ['ask']],
      ['Active', ['calm', 'live']],
      ['Quiet', ['quiet']],
    ]);
  });

  it('none: one list, needs-you first', () => {
    const view = buildSpaceSections(
      input({ rows, signals, layout: { ...DEFAULT_HOME_LAYOUT, groupBy: 'none' } })
    );
    expect(shape(view)).toEqual([[null, ['ask', 'quiet', 'calm', 'live']]]);
  });
});

describe('buildSpaceSections — sorting', () => {
  const rows = [row('r1', 'zeta'), row('r2', 'Alpha'), row('r3', 'beta'), row('r4', 'gamma')];

  it('pinned first, then needs you, then recent activity', () => {
    const view = buildSpaceSections(
      input({
        rows,
        signals: new Map(rows.map((r) => [r.bindingId, sig({ needsYou: r.bindingId === 'r4' })])),
        pinned: new Set(['r3']),
      })
    );
    expect(ids(view.sections[0]!.rows)).toEqual(['r3', 'r4', 'r1', 'r2']);
  });

  it('pinned spaces lead their own group, and the name order still holds inside', () => {
    const layout: HomeLayout = {
      ...DEFAULT_HOME_LAYOUT,
      sortBy: 'name',
      groups: [{ id: 'g1', name: 'Launch', collapsed: false, spaces: ['r1', 'r2'] }],
    };
    const view = buildSpaceSections(input({ rows, layout, pinned: new Set(['r1', 'r4']) }));
    expect(shape(view)).toEqual([
      ['Launch', ['r1', 'r2']],
      ['Ungrouped', ['r4', 'r3']],
    ]);
  });

  it('or by name, ignoring case', () => {
    const view = buildSpaceSections(
      input({ rows, layout: { ...DEFAULT_HOME_LAYOUT, sortBy: 'name' } })
    );
    expect(view.sections[0]!.rows.map((r) => r.name)).toEqual(['Alpha', 'beta', 'gamma', 'zeta']);
  });
});

describe('buildSpaceSections — quiet fold', () => {
  const rows = [row('a'), row('b'), row('c')];
  const signals = new Map([
    ['a', sig({ lastActivityAt: NOW - 30 * DAY })],
    ['b', sig()],
    ['c', sig({ lastActivityAt: null })],
  ]);

  it('shows quiet spaces in place by default', () => {
    expect(buildSpaceSections(input({ rows, signals })).folded).toEqual([]);
  });

  it('"Show quiet spaces" off folds them out of every section, whatever the grouping', () => {
    for (const groupBy of ['custom', 'state', 'none'] as const) {
      const layout: HomeLayout = {
        ...DEFAULT_HOME_LAYOUT,
        groupBy,
        showQuiet: false,
        groups: [{ id: 'g', name: 'G', collapsed: false, spaces: ['a', 'b'] }],
      };
      const view = buildSpaceSections(input({ rows, signals, layout }));
      expect(ids(view.folded)).toEqual(['a', 'c']);
      expect(view.sections.flatMap((s) => ids(s.rows))).toEqual(['b']);
    }
  });
});

describe('nextGroupName', () => {
  it('numbers a taken name', () => {
    const layout: HomeLayout = {
      ...DEFAULT_HOME_LAYOUT,
      groups: ['New group', 'new group 2'].map((name, i) => ({
        id: `g${i}`,
        name,
        collapsed: false,
        spaces: [],
      })),
    };
    expect(nextGroupName(DEFAULT_HOME_LAYOUT)).toBe('New group');
    expect(nextGroupName(layout)).toBe('New group 3');
  });
});
