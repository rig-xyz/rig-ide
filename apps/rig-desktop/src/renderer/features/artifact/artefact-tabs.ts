/**
 * Session-first viewer: the artefact pane's tab model. Replaces the old
 * two-level `ArtifactPanelState` (browser ⇄ one file) — the right pane is
 * now a tabbed surface that exists only while it has tabs. No tabs is a
 * real state (the session owns the window and the pinned card floats over
 * it), not an empty pane.
 *
 * Two tab kinds: a file (one per path — re-opening an open file activates
 * its existing tab, browser convention) and the focus view (at most one —
 * it is a lens over the whole working set, so a second copy could only
 * disagree with the first).
 *
 * Pure data + transitions, no React: `App.tsx` holds one of these in
 * state and every mutation goes through here, so close-index arithmetic
 * and the singleton rules are testable without a DOM.
 */

export type ArtefactTab = { kind: 'file'; path: string } | { kind: 'focus' };

export type ArtefactTabsState = {
  tabs: readonly ArtefactTab[];
  /** Index into `tabs`; -1 exactly when `tabs` is empty. */
  active: number;
};

export const NO_TABS: ArtefactTabsState = { tabs: [], active: -1 };

export function activeTab(state: ArtefactTabsState): ArtefactTab | null {
  return state.tabs[state.active] ?? null;
}

/** Open (or re-activate) the tab for `path`. */
export function openFileTab(state: ArtefactTabsState, path: string): ArtefactTabsState {
  const existing = state.tabs.findIndex((tab) => tab.kind === 'file' && tab.path === path);
  if (existing !== -1) return { tabs: state.tabs, active: existing };
  return { tabs: [...state.tabs, { kind: 'file', path }], active: state.tabs.length };
}

/** Open (or re-activate) the single focus tab. */
export function openFocusTab(state: ArtefactTabsState): ArtefactTabsState {
  const existing = state.tabs.findIndex((tab) => tab.kind === 'focus');
  if (existing !== -1) return { tabs: state.tabs, active: existing };
  return { tabs: [...state.tabs, { kind: 'focus' }], active: state.tabs.length };
}

export function activateTab(state: ArtefactTabsState, index: number): ArtefactTabsState {
  if (index < 0 || index >= state.tabs.length) return state;
  return { tabs: state.tabs, active: index };
}

/**
 * Close the tab at `index`. The active tab prefers to stay what it was;
 * when the active tab itself closes, activation falls to the tab now at
 * the same index (the one that slid in from the right), then to the new
 * last tab — the browser rule people already know.
 */
export function closeTab(state: ArtefactTabsState, index: number): ArtefactTabsState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  if (tabs.length === 0) return NO_TABS;
  let active: number;
  if (state.active === index) active = Math.min(index, tabs.length - 1);
  else if (state.active > index) active = state.active - 1;
  else active = state.active;
  return { tabs, active };
}

/** Close whichever tab is active (the Esc path). No-op when there are none. */
export function closeActiveTab(state: ArtefactTabsState): ArtefactTabsState {
  return closeTab(state, state.active);
}

/**
 * Move the tab at `from` to position `to` (drag-reorder). The ACTIVE TAB
 * IS AN IDENTITY, not an index — whatever was active stays active wherever
 * it lands, including when it's the one being dragged.
 */
export function moveTab(state: ArtefactTabsState, from: number, to: number): ArtefactTabsState {
  if (from === to) return state;
  if (from < 0 || from >= state.tabs.length || to < 0 || to >= state.tabs.length) return state;
  const activeRef = state.tabs[state.active];
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { tabs, active: tabs.indexOf(activeRef) };
}
