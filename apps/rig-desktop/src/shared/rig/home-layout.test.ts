import { describe, expect, it } from 'vitest';
import {
  applyHomeLayoutAction,
  applyHomeLayoutActions,
  DEFAULT_HOME_LAYOUT,
  HOME_LAYOUT_LIMITS,
  parseHomeLayout,
  parseHomeLayoutAction,
  type HomeLayout,
  type HomeLayoutAction,
} from './home-layout';

const withGroups = (...groups: Array<[string, string[]]>): HomeLayout => ({
  ...DEFAULT_HOME_LAYOUT,
  groups: groups.map(([id, spaces]) => ({ id, name: id.toUpperCase(), collapsed: false, spaces })),
});

const membership = (layout: HomeLayout) =>
  Object.fromEntries(layout.groups.map((g) => [g.id, g.spaces]));

describe('applyHomeLayoutAction', () => {
  it('creates a group at the end, taking its spaces out of any other group', () => {
    const next = applyHomeLayoutAction(withGroups(['a', ['s1', 's2']]), {
      type: 'createGroup',
      id: 'b',
      name: '  Launch  ',
      spaces: ['s2', 's3', 's3'],
    });
    expect(next.groups.map((g) => [g.id, g.name])).toEqual([
      ['a', 'A'],
      ['b', 'Launch'],
    ]);
    expect(membership(next)).toEqual({ a: ['s1'], b: ['s2', 's3'] });
  });

  it('names a blank new group, and ignores a duplicate id or a bad one', () => {
    const named = applyHomeLayoutAction(DEFAULT_HOME_LAYOUT, {
      type: 'createGroup',
      id: 'g',
      name: '  ',
    });
    expect(named.groups[0]!.name).toBe('New group');
    expect(applyHomeLayoutAction(named, { type: 'createGroup', id: 'g', name: 'Again' })).toBe(
      named
    );
    expect(applyHomeLayoutAction(named, { type: 'createGroup', id: 'no spaces!', name: 'x' })).toBe(
      named
    );
  });

  it('stops at the group cap', () => {
    const full: HomeLayout = {
      ...DEFAULT_HOME_LAYOUT,
      groups: Array.from({ length: HOME_LAYOUT_LIMITS.maxGroups }, (_, i) => ({
        id: `g${i}`,
        name: 'G',
        collapsed: false,
        spaces: [],
      })),
    };
    expect(applyHomeLayoutAction(full, { type: 'createGroup', id: 'one-more', name: 'x' })).toBe(
      full
    );
  });

  it('renames, trimming and capping; a blank name changes nothing', () => {
    const layout = withGroups(['a', []]);
    expect(
      applyHomeLayoutAction(layout, { type: 'renameGroup', id: 'a', name: ' Ops ' }).groups[0]!.name
    ).toBe('Ops');
    expect(
      applyHomeLayoutAction(layout, { type: 'renameGroup', id: 'a', name: 'x'.repeat(200) })
        .groups[0]!.name
    ).toHaveLength(HOME_LAYOUT_LIMITS.maxGroupName);
    expect(applyHomeLayoutAction(layout, { type: 'renameGroup', id: 'a', name: '   ' })).toBe(
      layout
    );
  });

  it('deletes a group; its spaces are ungrouped again', () => {
    const next = applyHomeLayoutAction(withGroups(['a', ['s1']], ['b', ['s2']]), {
      type: 'deleteGroup',
      id: 'a',
    });
    expect(membership(next)).toEqual({ b: ['s2'] });
  });

  it('moves a space: into a group, between groups, back to ungrouped', () => {
    let layout = withGroups(['a', ['s1']], ['b', []]);
    layout = applyHomeLayoutAction(layout, { type: 'moveSpace', bindingId: 's2', groupId: 'a' });
    expect(membership(layout)).toEqual({ a: ['s1', 's2'], b: [] });
    layout = applyHomeLayoutAction(layout, { type: 'moveSpace', bindingId: 's1', groupId: 'b' });
    expect(membership(layout)).toEqual({ a: ['s2'], b: ['s1'] });
    layout = applyHomeLayoutAction(layout, { type: 'moveSpace', bindingId: 's1', groupId: null });
    expect(membership(layout)).toEqual({ a: ['s2'], b: [] });
  });

  it('moving to a group that no longer exists leaves the space ungrouped', () => {
    const next = applyHomeLayoutAction(withGroups(['a', ['s1']]), {
      type: 'moveSpace',
      bindingId: 's1',
      groupId: 'gone',
    });
    expect(membership(next)).toEqual({ a: [] });
  });

  it('reorders groups, clamping the index', () => {
    const layout = withGroups(['a', []], ['b', []], ['c', []]);
    const ids = (l: HomeLayout) => l.groups.map((g) => g.id);
    expect(
      ids(applyHomeLayoutAction(layout, { type: 'reorderGroup', id: 'a', toIndex: 2 }))
    ).toEqual(['b', 'c', 'a']);
    expect(
      ids(applyHomeLayoutAction(layout, { type: 'reorderGroup', id: 'c', toIndex: 0 }))
    ).toEqual(['c', 'a', 'b']);
    expect(
      ids(applyHomeLayoutAction(layout, { type: 'reorderGroup', id: 'b', toIndex: 99 }))
    ).toEqual(['a', 'c', 'b']);
    expect(applyHomeLayoutAction(layout, { type: 'reorderGroup', id: 'zz', toIndex: 0 })).toBe(
      layout
    );
  });

  it('remembers collapse, for groups and built-in sections', () => {
    let layout = withGroups(['a', []]);
    layout = applyHomeLayoutAction(layout, { type: 'setGroupCollapsed', id: 'a', collapsed: true });
    layout = applyHomeLayoutAction(layout, {
      type: 'setSectionCollapsed',
      key: 'ungrouped',
      collapsed: true,
    });
    layout = applyHomeLayoutAction(layout, {
      type: 'setSectionCollapsed',
      key: 'ungrouped',
      collapsed: true,
    });
    expect(layout.groups[0]!.collapsed).toBe(true);
    expect(layout.collapsed).toEqual(['ungrouped']);
    layout = applyHomeLayoutAction(layout, {
      type: 'setSectionCollapsed',
      key: 'ungrouped',
      collapsed: false,
    });
    expect(layout.collapsed).toEqual([]);
  });

  it('sets the menu choices', () => {
    const next = applyHomeLayoutActions(DEFAULT_HOME_LAYOUT, [
      { type: 'setGroupBy', groupBy: 'state' },
      { type: 'setSortBy', sortBy: 'name' },
      { type: 'setShowQuiet', value: false },
      { type: 'setShowEmptyGroups', value: true },
    ]);
    expect(next).toMatchObject({
      groupBy: 'state',
      sortBy: 'name',
      showQuiet: false,
      showEmptyGroups: true,
    });
  });

  it('replays the same edits onto another copy (how a conflicting save is merged)', () => {
    const mine: HomeLayoutAction[] = [
      { type: 'createGroup', id: 'g1', name: 'Mine', spaces: ['s1'] },
      { type: 'moveSpace', bindingId: 's2', groupId: 'g1' },
    ];
    // Meanwhile another computer made a group holding s2.
    const theirs = withGroups(['other', ['s2', 's3']]);
    expect(membership(applyHomeLayoutActions(theirs, mine))).toEqual({
      other: ['s3'],
      g1: ['s1', 's2'],
    });
  });
});

describe('parseHomeLayout', () => {
  it('fills defaults and drops what is bad', () => {
    expect(parseHomeLayout({})).toEqual(DEFAULT_HOME_LAYOUT);
    expect(
      parseHomeLayout({
        groupBy: 'topics',
        groups: [
          { id: 'a', name: 'A', spaces: ['s1', 's1', 7] },
          { id: 'a', name: 'dup', spaces: [] },
          { id: 'b', name: ' ', spaces: [] },
          { id: 'c', name: 'C', collapsed: true, spaces: ['s1', 's2'] },
        ],
      })
    ).toEqual({
      ...DEFAULT_HOME_LAYOUT,
      groups: [
        { id: 'a', name: 'A', collapsed: false, spaces: ['s1'] },
        { id: 'c', name: 'C', collapsed: true, spaces: ['s2'] },
      ],
    });
    expect(parseHomeLayout(null)).toBeNull();
  });
});

describe('parseHomeLayoutAction', () => {
  it('round-trips every action and refuses junk', () => {
    const actions = [
      { type: 'setGroupBy', groupBy: 'none' },
      { type: 'setSortBy', sortBy: 'name' },
      { type: 'setShowQuiet', value: false },
      { type: 'setShowEmptyGroups', value: true },
      { type: 'createGroup', id: 'g', name: 'G', spaces: ['s'] },
      { type: 'renameGroup', id: 'g', name: 'H' },
      { type: 'deleteGroup', id: 'g' },
      { type: 'moveSpace', bindingId: 's', groupId: null },
      { type: 'moveSpace', bindingId: 's', groupId: 'g' },
      { type: 'reorderGroup', id: 'g', toIndex: 1 },
      { type: 'setGroupCollapsed', id: 'g', collapsed: true },
      { type: 'setSectionCollapsed', key: 'ungrouped', collapsed: true },
    ];
    for (const action of actions)
      expect(parseHomeLayoutAction(JSON.parse(JSON.stringify(action)))).toEqual(action);
    expect(parseHomeLayoutAction({ type: 'dropTables' })).toBeNull();
    expect(parseHomeLayoutAction({ type: 'moveSpace', bindingId: 's', groupId: 3 })).toBeNull();
    expect(parseHomeLayoutAction('moveSpace')).toBeNull();
  });
});
