import { describe, expect, it } from 'vitest';
import {
  activateTab,
  activeTab,
  closeActiveTab,
  closeTab,
  moveTab,
  NO_TABS,
  openFileTab,
  openFocusTab,
  openPageTab,
  renamePageTab,
  retargetFileTab,
  type ArtefactTabsState,
} from './artefact-tabs';

function open(...paths: string[]): ArtefactTabsState {
  return paths.reduce((state, path) => openFileTab(state, path), NO_TABS);
}

describe('openFileTab', () => {
  it('appends and activates a new file tab', () => {
    const state = openFileTab(NO_TABS, '/rig/a.md');
    expect(state.tabs).toEqual([{ kind: 'file', path: '/rig/a.md' }]);
    expect(state.active).toBe(0);
    expect(activeTab(state)).toEqual({ kind: 'file', path: '/rig/a.md' });
  });

  it('re-activates an existing tab instead of duplicating it', () => {
    const state = openFileTab(open('/rig/a.md', '/rig/b.md'), '/rig/a.md');
    expect(state.tabs).toHaveLength(2);
    expect(state.active).toBe(0);
  });
});

describe('openFocusTab', () => {
  it('is a singleton — a second open re-activates the first', () => {
    let state = openFocusTab(open('/rig/a.md'));
    expect(state.active).toBe(1);
    state = openFileTab(state, '/rig/b.md');
    state = openFocusTab(state);
    expect(state.tabs.filter((tab) => tab.kind === 'focus')).toHaveLength(1);
    expect(state.active).toBe(1);
  });
});

describe('closeTab', () => {
  it('closing the last remaining tab returns to the no-tabs state', () => {
    expect(closeTab(open('/rig/a.md'), 0)).toEqual(NO_TABS);
  });

  it('closing the active tab activates the one that slid into its slot', () => {
    const state = closeTab(activateTab(open('/rig/a.md', '/rig/b.md', '/rig/c.md'), 1), 1);
    expect(state.tabs.map((t) => (t.kind === 'file' ? t.path : 'focus'))).toEqual([
      '/rig/a.md',
      '/rig/c.md',
    ]);
    expect(state.active).toBe(1);
  });

  it('closing the active LAST tab falls back to the new last tab', () => {
    const state = closeTab(open('/rig/a.md', '/rig/b.md'), 1);
    expect(state.active).toBe(0);
  });

  it('closing a tab left of the active one keeps the same tab active', () => {
    const state = closeTab(open('/rig/a.md', '/rig/b.md', '/rig/c.md'), 0);
    expect(activeTab(state)).toEqual({ kind: 'file', path: '/rig/c.md' });
  });

  it('closing a tab right of the active one keeps the same tab active', () => {
    const state = closeTab(activateTab(open('/rig/a.md', '/rig/b.md', '/rig/c.md'), 0), 2);
    expect(activeTab(state)).toEqual({ kind: 'file', path: '/rig/a.md' });
  });

  it('ignores out-of-range indexes', () => {
    const state = open('/rig/a.md');
    expect(closeTab(state, 5)).toBe(state);
    expect(closeTab(state, -1)).toBe(state);
  });
});

describe('moveTab', () => {
  it('moves a tab and keeps the active tab active by identity', () => {
    // Active is c (index 2); drag a (index 0) to the end.
    const state = moveTab(open('/rig/a.md', '/rig/b.md', '/rig/c.md'), 0, 2);
    expect(state.tabs.map((t) => (t.kind === 'file' ? t.path : 'focus'))).toEqual([
      '/rig/b.md',
      '/rig/c.md',
      '/rig/a.md',
    ]);
    expect(activeTab(state)).toEqual({ kind: 'file', path: '/rig/c.md' });
  });

  it('a dragged active tab stays active at its new position', () => {
    const state = moveTab(activateTab(open('/rig/a.md', '/rig/b.md', '/rig/c.md'), 0), 0, 2);
    expect(state.active).toBe(2);
    expect(activeTab(state)).toEqual({ kind: 'file', path: '/rig/a.md' });
  });

  it('ignores no-op and out-of-range moves', () => {
    const state = open('/rig/a.md', '/rig/b.md');
    expect(moveTab(state, 1, 1)).toBe(state);
    expect(moveTab(state, 0, 5)).toBe(state);
    expect(moveTab(state, -1, 0)).toBe(state);
  });
});

describe('closeActiveTab', () => {
  it('closes the active tab, and is a no-op with no tabs', () => {
    expect(closeActiveTab(NO_TABS)).toEqual(NO_TABS);
    const state = closeActiveTab(open('/rig/a.md', '/rig/b.md'));
    expect(state.tabs).toEqual([{ kind: 'file', path: '/rig/a.md' }]);
    expect(state.active).toBe(0);
  });
});

describe('openPageTab', () => {
  it('opens one tab per page link, beside file tabs, and re-activates it when opened again', () => {
    let state = openFileTab(NO_TABS, '/rigs/one/plan.md');
    state = openPageTab(state, 'https://claude.ai/artifact/abc', 'Claude artifact');
    expect(state.tabs).toEqual([
      { kind: 'file', path: '/rigs/one/plan.md' },
      { kind: 'page', url: 'https://claude.ai/artifact/abc', title: 'Claude artifact' },
    ]);
    state = activateTab(state, 0);
    state = openPageTab(state, 'https://claude.ai/artifact/abc', 'Claude artifact');
    expect(state).toMatchObject({ active: 1 });
    expect(state.tabs).toHaveLength(2);
  });
});

describe('renamePageTab', () => {
  it("takes the page's own title, leaving everything else as it was", () => {
    const state = openPageTab(openFileTab(NO_TABS, '/rigs/one/a.md'), 'https://claude.ai/artifact/abc', 'Claude artifact');
    const renamed = renamePageTab(state, 'https://claude.ai/artifact/abc', '  Pilot deck ');
    expect(renamed.tabs[1]).toEqual({ kind: 'page', url: 'https://claude.ai/artifact/abc', title: 'Pilot deck' });
    expect(renamed.active).toBe(state.active);
    expect(renamePageTab(renamed, 'https://claude.ai/artifact/abc', '')).toBe(renamed);
    expect(renamePageTab(renamed, 'https://other.example', 'x')).toBe(renamed);
  });
});

describe('retargetFileTab', () => {
  it('moves a renamed file\'s tab to its new path in place, keeping the active tab', () => {
    const state = activateTab(open('/rig/a.md', '/rig/b.md', '/rig/c.md'), 1);
    const moved = retargetFileTab(state, '/rig/b.md', '/rig/renamed.md');
    expect(moved.tabs.map((tab) => (tab.kind === 'file' ? tab.path : tab.kind))).toEqual([
      '/rig/a.md',
      '/rig/renamed.md',
      '/rig/c.md',
    ]);
    expect(moved.active).toBe(1);
    expect(retargetFileTab(moved, '/rig/missing.md', '/rig/x.md')).toBe(moved);
  });
});
