import { useCallback, useEffect, useState } from 'react';

/**
 * How one person arranged a space's tabs (spike, Rig Alpha): the order of its view tabs and which
 * ones they hid. Theirs alone and kept on this Mac; a tab's name is the view's own title in its
 * `view.json`, shared with everyone, and is not here.
 */
export type TabPrefs = { order: readonly string[]; hidden: readonly string[] };

export const NO_TAB_PREFS: TabPrefs = { order: [], hidden: [] };

const keyFor = (bindingId: string) => `rig.space-tabs.${bindingId}`;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function parseTabPrefs(text: string | null): TabPrefs {
  if (!text) return NO_TAB_PREFS;
  try {
    const value = JSON.parse(text) as { order?: unknown; hidden?: unknown } | null;
    return { order: strings(value?.order), hidden: strings(value?.hidden) };
  } catch {
    return NO_TAB_PREFS;
  }
}

/**
 * The names in the person's order. Ones they never placed follow, in the order the views
 * themselves ask for (`order` in `view.json`, lowest first), then as they came.
 */
export function orderTabs(
  names: readonly string[],
  order: readonly string[],
  viewOrder: (name: string) => number | null = () => null
): string[] {
  const rank = new Map(order.map((name, index) => [name, index]));
  const placed = names.filter((name) => rank.has(name)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const rest = names
    .filter((name) => !rank.has(name))
    .map((name, index) => ({ name, index, at: viewOrder(name) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.index - b.index)
    .map((entry) => entry.name);
  return [...placed, ...rest];
}

export function hideTab(prefs: TabPrefs, name: string): TabPrefs {
  return prefs.hidden.includes(name) ? prefs : { ...prefs, hidden: [...prefs.hidden, name] };
}

export function showTab(prefs: TabPrefs, name: string): TabPrefs {
  return { ...prefs, hidden: prefs.hidden.filter((hidden) => hidden !== name) };
}

/** Views that no longer exist drop out, so a view made later under an old name starts clean. */
export function pruneTabPrefs(prefs: TabPrefs, names: readonly string[]): TabPrefs {
  const order = prefs.order.filter((name) => names.includes(name));
  const hidden = prefs.hidden.filter((name) => names.includes(name));
  return order.length === prefs.order.length && hidden.length === prefs.hidden.length
    ? prefs
    : { order, hidden };
}

function load(bindingId: string | null): TabPrefs {
  if (!bindingId) return NO_TAB_PREFS;
  try {
    return parseTabPrefs(window.localStorage.getItem(keyFor(bindingId)));
  } catch {
    return NO_TAB_PREFS;
  }
}

export function useTabPrefs(
  bindingId: string | null
): [TabPrefs, (change: (prefs: TabPrefs) => TabPrefs) => void] {
  const [state, setState] = useState(() => ({ bindingId, prefs: load(bindingId) }));
  useEffect(() => setState({ bindingId, prefs: load(bindingId) }), [bindingId]);
  const update = useCallback(
    (change: (prefs: TabPrefs) => TabPrefs) => {
      if (!bindingId) return;
      setState((current) => {
        const prefs = change(current.bindingId === bindingId ? current.prefs : load(bindingId));
        try {
          window.localStorage.setItem(keyFor(bindingId), JSON.stringify(prefs));
        } catch {
          // Storage is full or off: the arrangement holds until the window closes.
        }
        return { bindingId, prefs };
      });
    },
    [bindingId]
  );
  return [state.bindingId === bindingId ? state.prefs : NO_TAB_PREFS, update];
}

/** A view's `view.json` with a new title, keeping everything else it says. Null when the title is empty. */
export function withViewTitle(metaText: string | null, title: string): string | null {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return null;
  let meta: Record<string, unknown> = {};
  try {
    const value: unknown = metaText ? JSON.parse(metaText) : null;
    if (value && typeof value === 'object' && !Array.isArray(value))
      meta = value as Record<string, unknown>;
    else if (metaText) return null;
  } catch {
    // A view.json that does not parse is not rewritten: its author's words are not thrown away.
    return null;
  }
  return `${JSON.stringify({ ...meta, title: clean }, null, 2)}\n`;
}
