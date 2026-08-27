import { describe, expect, it } from 'vitest';
import {
  activateTab,
  activeTab,
  closeActiveTab,
  closeTab,
  NO_TABS,
  openFileTab,
  openFocusTab,
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

describe('closeActiveTab', () => {
  it('closes the active tab, and is a no-op with no tabs', () => {
    expect(closeActiveTab(NO_TABS)).toEqual(NO_TABS);
    const state = closeActiveTab(open('/rig/a.md', '/rig/b.md'));
    expect(state.tabs).toEqual([{ kind: 'file', path: '/rig/a.md' }]);
    expect(state.active).toBe(0);
  });
});
