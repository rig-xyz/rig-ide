/**
 * "Many spaces on Home" v1: how the Spaces card splits its rows into
 * sections (custom groups, state, or one list), orders each section, and
 * folds quiet spaces away. Pure, like `space-status-state.ts`: the card
 * computes each space's signals and hands them in.
 */

import { HOME_SECTION_KEYS, type HomeLayout } from '@shared/rig/home-layout';

/** Quiet: nothing new in a space for this long. */
export const QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export type SpaceSignals = {
  /** A mention, reply or request for you is unread, or your agent waits on your approval. */
  needsYou: boolean;
  /** An agent is running in it right now. */
  live: boolean;
  /** The newest thing that happened in it (relay or this computer), or null if nothing ever did. */
  lastActivityAt: number | null;
  /** Its live status has loaded (or Home is offline and goes by this computer's data). Until then it's never quiet. */
  known: boolean;
};

export function isQuiet(signals: SpaceSignals | undefined, now: number): boolean {
  if (!signals || !signals.known || signals.needsYou || signals.live) return false;
  return signals.lastActivityAt === null || now - signals.lastActivityAt > QUIET_AFTER_MS;
}

export type SpaceSectionKind = 'ungrouped' | 'group' | 'state' | 'all';

export type SpaceSection<T> = {
  /** Stable: the group id, or a `HOME_SECTION_KEYS` value, or `'all'`. */
  key: string;
  kind: SpaceSectionKind;
  /** Null for the one headerless list (no groups yet, or grouping off). */
  title: string | null;
  groupId?: string;
  rows: T[];
  collapsed: boolean;
  /** False for an empty section the layout says to hide. */
  visible: boolean;
};

export type SpaceSectionsView<T> = {
  sections: SpaceSection<T>[];
  /** Quiet spaces folded into one line at the bottom ("Show quiet spaces" off). Empty when shown in place. */
  folded: T[];
};

export type SpaceSectionsInput<T extends { bindingId: string; name: string }> = {
  /** Already filtered by the card's chips. */
  rows: readonly T[];
  layout: HomeLayout;
  signals: ReadonlyMap<string, SpaceSignals>;
  pinned: ReadonlySet<string>;
  /** The "Recent activity" order (`sortSpaceRowsByActivity`), as each row's index. */
  recentOrder: ReadonlyMap<string, number>;
  now: number;
  /** Groups made on this computer since Home opened: shown even while still empty, so they can be filled. */
  keepVisible?: ReadonlySet<string>;
};

/**
 * Inside a section: spaces that need you first, then pinned ones, then the
 * chosen order (recent activity, or name).
 */
export function compareSpaceRows<T extends { bindingId: string; name: string }>(
  input: Pick<SpaceSectionsInput<T>, 'layout' | 'signals' | 'pinned' | 'recentOrder'>
): (a: T, b: T) => number {
  const recent = (row: T) => input.recentOrder.get(row.bindingId) ?? Number.MAX_SAFE_INTEGER;
  return (a, b) => {
    const needs =
      Number(input.signals.get(b.bindingId)?.needsYou ?? false) -
      Number(input.signals.get(a.bindingId)?.needsYou ?? false);
    if (needs !== 0) return needs;
    const pin = Number(input.pinned.has(b.bindingId)) - Number(input.pinned.has(a.bindingId));
    if (pin !== 0) return pin;
    if (input.layout.sortBy === 'name') {
      const byName = a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
      if (byName !== 0) return byName;
    }
    return recent(a) - recent(b);
  };
}

export function buildSpaceSections<T extends { bindingId: string; name: string }>(
  input: SpaceSectionsInput<T>
): SpaceSectionsView<T> {
  const { layout, now } = input;
  const compare = compareSpaceRows(input);
  const sort = (rows: T[]) => rows.sort(compare);
  const quiet = (row: T) => isQuiet(input.signals.get(row.bindingId), now);
  const fold = !layout.showQuiet;
  const folded = fold ? sort(input.rows.filter(quiet)) : [];
  const rows = fold ? input.rows.filter((r) => !quiet(r)) : [...input.rows];
  const collapsed = (key: string) => layout.collapsed.includes(key);

  if (layout.groupBy === 'none') {
    return {
      sections: [
        { key: 'all', kind: 'all', title: null, rows: sort(rows), collapsed: false, visible: true },
      ],
      folded,
    };
  }

  if (layout.groupBy === 'state') {
    const needsYou: T[] = [];
    const active: T[] = [];
    const quietRows: T[] = [];
    for (const row of rows) {
      if (input.signals.get(row.bindingId)?.needsYou) needsYou.push(row);
      else if (quiet(row)) quietRows.push(row);
      else active.push(row);
    }
    const section = (key: string, title: string, list: T[]): SpaceSection<T> => ({
      key,
      kind: 'state',
      title,
      rows: sort(list),
      collapsed: collapsed(key),
      visible: list.length > 0,
    });
    return {
      sections: [
        section(HOME_SECTION_KEYS.needsYou, 'Needs you', needsYou),
        section(HOME_SECTION_KEYS.active, 'Active', active),
        section(HOME_SECTION_KEYS.quiet, 'Quiet', quietRows),
      ],
      folded,
    };
  }

  // Custom groups. With none made yet, one headerless list.
  if (layout.groups.length === 0) {
    return {
      sections: [
        { key: 'all', kind: 'all', title: null, rows: sort(rows), collapsed: false, visible: true },
      ],
      folded,
    };
  }
  const groupOf = new Map<string, string>();
  for (const group of layout.groups)
    for (const id of group.spaces) if (!groupOf.has(id)) groupOf.set(id, group.id);
  const byGroup = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const row of rows) {
    const groupId = groupOf.get(row.bindingId);
    if (groupId) byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), row]);
    else ungrouped.push(row);
  }
  // Your groups first; spaces in none sit below them, untitled while you
  // have no groups at all (then it's just the list).
  const ungroupedSection: SpaceSection<T> = {
    key: HOME_SECTION_KEYS.ungrouped,
    kind: 'ungrouped',
    title: layout.groups.length > 0 ? 'Ungrouped' : null,
    rows: sort(ungrouped),
    collapsed: layout.groups.length > 0 && collapsed(HOME_SECTION_KEYS.ungrouped),
    visible: ungrouped.length > 0,
  };
  return {
    sections: [
      ...layout.groups.map((group): SpaceSection<T> => {
        const list = sort(byGroup.get(group.id) ?? []);
        return {
          key: group.id,
          kind: 'group',
          title: group.name,
          groupId: group.id,
          rows: list,
          collapsed: group.collapsed,
          visible:
            list.length > 0 ||
            layout.showEmptyGroups ||
            (input.keepVisible?.has(group.id) ?? false),
        };
      }),
      ungroupedSection,
    ],
    folded,
  };
}

/** The group a space is in, or null. */
export function groupOfSpace(layout: HomeLayout, bindingId: string): string | null {
  return layout.groups.find((g) => g.spaces.includes(bindingId))?.id ?? null;
}

/** "New group", or "New group 2", 3, … when that name is taken. */
export function nextGroupName(layout: HomeLayout, base = 'New group'): string {
  const taken = new Set(layout.groups.map((g) => g.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
