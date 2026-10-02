import { defineEvent } from '../lib/ipc/events';

/**
 * How the Spaces card on Home is arranged ("Many spaces on Home", v1): the
 * person's own groups and the card menu's choices. Kept on their account on
 * the relay (`GET/PUT /v1/me/home-layout`, tap `packages/relay/src/routes/
 * home-layout.ts`) so it follows them to another computer; main caches the
 * last copy and any edits not yet saved (`main/rig/home-layout.ts`), so Home
 * renders it at once and offline.
 *
 * Every edit is a `HomeLayoutAction` run through `applyHomeLayoutAction`, a
 * pure reducer. Main keeps the edits not yet on the relay as a list of
 * actions, so when another computer saved first it replays them on top of
 * that copy instead of overwriting it.
 *
 * Groups name spaces by binding id, so a rename changes nothing here; a
 * space you left or that was deleted simply isn't in your list any more and
 * Home skips it (`space-sections.ts`).
 */

export type HomeGroupBy = 'custom' | 'state' | 'none';
export type HomeSortBy = 'recent' | 'name';

export type HomeGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  /** Binding ids, in the order they were added. A space is in at most one group. */
  spaces: string[];
};

export type HomeLayout = {
  groupBy: HomeGroupBy;
  sortBy: HomeSortBy;
  showQuiet: boolean;
  showEmptyGroups: boolean;
  /** Built-in sections the person collapsed (`HOME_SECTION_KEYS`). Groups carry their own flag. */
  collapsed: string[];
  /** In display order. */
  groups: HomeGroup[];
};

export const DEFAULT_HOME_LAYOUT: HomeLayout = {
  groupBy: 'custom',
  sortBy: 'recent',
  showQuiet: true,
  showEmptyGroups: false,
  collapsed: [],
  groups: [],
};

/** Mirrors the relay's `HOME_LAYOUT_LIMITS`: an edit that would break one is a no-op here. */
export const HOME_LAYOUT_LIMITS = {
  maxGroups: 100,
  maxGroupName: 80,
  maxSpacesPerGroup: 500,
  maxCollapsed: 50,
} as const;

export const HOME_SECTION_KEYS = {
  ungrouped: 'ungrouped',
  needsYou: 'state:needsYou',
  active: 'state:active',
  quiet: 'state:quiet',
} as const;

export const NEW_GROUP_NAME = 'New group';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECTION_KEY = /^[A-Za-z0-9_:-]{1,64}$/;

export type HomeLayoutAction =
  | { type: 'setGroupBy'; groupBy: HomeGroupBy }
  | { type: 'setSortBy'; sortBy: HomeSortBy }
  | { type: 'setShowQuiet'; value: boolean }
  | { type: 'setShowEmptyGroups'; value: boolean }
  /** `id` is minted by the caller (`newGroupId`) so every replay of this action makes the same group. */
  | { type: 'createGroup'; id: string; name: string; spaces?: string[] }
  | { type: 'renameGroup'; id: string; name: string }
  /** Its spaces go back to Ungrouped. */
  | { type: 'deleteGroup'; id: string }
  /** `groupId: null` is Ungrouped. A group that no longer exists also leaves the space ungrouped. */
  | { type: 'moveSpace'; bindingId: string; groupId: string | null }
  | { type: 'reorderGroup'; id: string; toIndex: number }
  | { type: 'setGroupCollapsed'; id: string; collapsed: boolean }
  | { type: 'setSectionCollapsed'; key: string; collapsed: boolean };

export function newGroupId(): string {
  return `grp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function cleanName(name: string): string {
  return name.trim().slice(0, HOME_LAYOUT_LIMITS.maxGroupName).trim();
}

function withoutSpaces(groups: readonly HomeGroup[], ids: ReadonlySet<string>): HomeGroup[] {
  return groups.map((g) =>
    g.spaces.some((s) => ids.has(s)) ? { ...g, spaces: g.spaces.filter((s) => !ids.has(s)) } : g
  );
}

export function applyHomeLayoutAction(layout: HomeLayout, action: HomeLayoutAction): HomeLayout {
  switch (action.type) {
    case 'setGroupBy':
      return { ...layout, groupBy: action.groupBy };
    case 'setSortBy':
      return { ...layout, sortBy: action.sortBy };
    case 'setShowQuiet':
      return { ...layout, showQuiet: action.value };
    case 'setShowEmptyGroups':
      return { ...layout, showEmptyGroups: action.value };
    case 'createGroup': {
      const name = cleanName(action.name) || NEW_GROUP_NAME;
      if (!ID.test(action.id) || layout.groups.some((g) => g.id === action.id)) return layout;
      if (layout.groups.length >= HOME_LAYOUT_LIMITS.maxGroups) return layout;
      const spaces = [...new Set(action.spaces ?? [])]
        .filter((s) => ID.test(s))
        .slice(0, HOME_LAYOUT_LIMITS.maxSpacesPerGroup);
      return {
        ...layout,
        groups: [
          ...withoutSpaces(layout.groups, new Set(spaces)),
          { id: action.id, name, collapsed: false, spaces },
        ],
      };
    }
    case 'renameGroup': {
      const name = cleanName(action.name);
      if (!name) return layout;
      return {
        ...layout,
        groups: layout.groups.map((g) => (g.id === action.id ? { ...g, name } : g)),
      };
    }
    case 'deleteGroup':
      return { ...layout, groups: layout.groups.filter((g) => g.id !== action.id) };
    case 'moveSpace': {
      if (!ID.test(action.bindingId)) return layout;
      const target = layout.groups.find((g) => g.id === action.groupId);
      if (target?.spaces.includes(action.bindingId)) return layout;
      if (target && target.spaces.length >= HOME_LAYOUT_LIMITS.maxSpacesPerGroup) return layout;
      const groups = withoutSpaces(layout.groups, new Set([action.bindingId]));
      return {
        ...layout,
        groups: target
          ? groups.map((g) =>
              g.id === target.id ? { ...g, spaces: [...g.spaces, action.bindingId] } : g
            )
          : groups,
      };
    }
    case 'reorderGroup': {
      const from = layout.groups.findIndex((g) => g.id === action.id);
      if (from < 0) return layout;
      const groups = [...layout.groups];
      const [moved] = groups.splice(from, 1);
      const to = Math.max(0, Math.min(groups.length, Math.trunc(action.toIndex)));
      groups.splice(to, 0, moved!);
      return { ...layout, groups };
    }
    case 'setGroupCollapsed':
      return {
        ...layout,
        groups: layout.groups.map((g) =>
          g.id === action.id ? { ...g, collapsed: action.collapsed } : g
        ),
      };
    case 'setSectionCollapsed': {
      if (!SECTION_KEY.test(action.key)) return layout;
      const rest = layout.collapsed.filter((k) => k !== action.key);
      if (!action.collapsed) return { ...layout, collapsed: rest };
      if (rest.length >= HOME_LAYOUT_LIMITS.maxCollapsed) return layout;
      return { ...layout, collapsed: [...rest, action.key] };
    }
  }
}

export function applyHomeLayoutActions(
  layout: HomeLayout,
  actions: readonly HomeLayoutAction[]
): HomeLayout {
  return actions.reduce(applyHomeLayoutAction, layout);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads a layout from the relay or the cache, forgivingly: a missing or bad
 * field takes its default, a bad group is dropped, and a space already in an
 * earlier group is dropped from a later one. Null only when it isn't a
 * layout at all.
 */
export function parseHomeLayout(value: unknown): HomeLayout | null {
  if (!isRecord(value)) return null;
  const d = DEFAULT_HOME_LAYOUT;
  const seenGroups = new Set<string>();
  const seenSpaces = new Set<string>();
  const groups: HomeGroup[] = [];
  for (const g of Array.isArray(value.groups) ? value.groups : []) {
    if (!isRecord(g) || typeof g.id !== 'string' || !ID.test(g.id) || seenGroups.has(g.id))
      continue;
    const name = typeof g.name === 'string' ? cleanName(g.name) : '';
    if (!name) continue;
    seenGroups.add(g.id);
    const spaces: string[] = [];
    for (const s of Array.isArray(g.spaces) ? g.spaces : []) {
      if (typeof s !== 'string' || !ID.test(s) || seenSpaces.has(s)) continue;
      seenSpaces.add(s);
      spaces.push(s);
    }
    groups.push({ id: g.id, name, collapsed: g.collapsed === true, spaces });
  }
  return {
    groupBy: value.groupBy === 'state' || value.groupBy === 'none' ? value.groupBy : d.groupBy,
    sortBy: value.sortBy === 'name' ? 'name' : d.sortBy,
    showQuiet: typeof value.showQuiet === 'boolean' ? value.showQuiet : d.showQuiet,
    showEmptyGroups:
      typeof value.showEmptyGroups === 'boolean' ? value.showEmptyGroups : d.showEmptyGroups,
    collapsed: [
      ...new Set(
        (Array.isArray(value.collapsed) ? value.collapsed : []).filter(
          (k): k is string => typeof k === 'string' && SECTION_KEY.test(k)
        )
      ),
    ].slice(0, HOME_LAYOUT_LIMITS.maxCollapsed),
    groups: groups.slice(0, HOME_LAYOUT_LIMITS.maxGroups),
  };
}

export function parseHomeLayoutAction(value: unknown): HomeLayoutAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const str = (k: string) => (typeof value[k] === 'string' ? (value[k] as string) : null);
  const bool = (k: string) => (typeof value[k] === 'boolean' ? (value[k] as boolean) : null);
  switch (value.type) {
    case 'setGroupBy':
      return value.groupBy === 'custom' || value.groupBy === 'state' || value.groupBy === 'none'
        ? { type: 'setGroupBy', groupBy: value.groupBy }
        : null;
    case 'setSortBy':
      return value.sortBy === 'recent' || value.sortBy === 'name'
        ? { type: 'setSortBy', sortBy: value.sortBy }
        : null;
    case 'setShowQuiet':
    case 'setShowEmptyGroups': {
      const v = bool('value');
      return v === null ? null : { type: value.type, value: v };
    }
    case 'createGroup': {
      const id = str('id');
      const name = str('name');
      if (id === null || name === null) return null;
      const spaces = Array.isArray(value.spaces)
        ? value.spaces.filter((s): s is string => typeof s === 'string')
        : [];
      return { type: 'createGroup', id, name, spaces };
    }
    case 'renameGroup': {
      const id = str('id');
      const name = str('name');
      return id === null || name === null ? null : { type: 'renameGroup', id, name };
    }
    case 'deleteGroup': {
      const id = str('id');
      return id === null ? null : { type: 'deleteGroup', id };
    }
    case 'moveSpace': {
      const bindingId = str('bindingId');
      const groupId = value.groupId === null ? null : str('groupId');
      if (bindingId === null || (groupId === null && value.groupId !== null)) return null;
      return { type: 'moveSpace', bindingId, groupId };
    }
    case 'reorderGroup': {
      const id = str('id');
      const toIndex =
        typeof value.toIndex === 'number' && Number.isFinite(value.toIndex) ? value.toIndex : null;
      return id === null || toIndex === null ? null : { type: 'reorderGroup', id, toIndex };
    }
    case 'setGroupCollapsed': {
      const id = str('id');
      const collapsed = bool('collapsed');
      return id === null || collapsed === null
        ? null
        : { type: 'setGroupCollapsed', id, collapsed };
    }
    case 'setSectionCollapsed': {
      const key = str('key');
      const collapsed = bool('collapsed');
      return key === null || collapsed === null
        ? null
        : { type: 'setSectionCollapsed', key, collapsed };
    }
    default:
      return null;
  }
}

/** Main → renderer: the layout Home should show changed (the relay's copy came in, or a save was reconciled). */
export const rigHomeLayoutChangedChannel = defineEvent<{ layout: HomeLayout }>(
  'rig:home-layout-changed'
);
