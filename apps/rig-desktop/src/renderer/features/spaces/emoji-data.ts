import { canonicalEmoji, QUICK_REACTIONS } from '@shared/spaces/reactions';

/**
 * The emoji the Room's picker and `:` autocomplete offer: Unicode's own
 * (no custom emoji), from emojibase's compact English data with GitHub's
 * shortcodes (`:tada:`, `:+1:`). Loaded on first use, never at startup:
 * the data is ~600KB and most sessions never open the picker.
 */

export type EmojiEntry = {
  /** The spelling the relay stores (`canonicalEmoji`). */
  emoji: string;
  label: string;
  shortcodes: string[];
  tags: string[];
  group: number;
};

export type EmojiGroup = { key: string; label: string; entries: EmojiEntry[] };

export type EmojiIndex = { entries: EmojiEntry[]; groups: EmojiGroup[] };

/** Unicode's emoji groups, in order; group 2 (skin tones, hair) is building blocks, not emoji to pick. */
const GROUPS: ReadonlyArray<{ id: number; key: string; label: string }> = [
  { id: 0, key: 'smileys', label: 'Smileys & emotion' },
  { id: 1, key: 'people', label: 'People & body' },
  { id: 3, key: 'nature', label: 'Animals & nature' },
  { id: 4, key: 'food', label: 'Food & drink' },
  { id: 5, key: 'travel', label: 'Travel & places' },
  { id: 6, key: 'activities', label: 'Activities' },
  { id: 7, key: 'objects', label: 'Objects' },
  { id: 8, key: 'symbols', label: 'Symbols' },
  { id: 9, key: 'flags', label: 'Flags' },
];

type CompactRow = {
  unicode: string;
  label: string;
  hexcode: string;
  group?: number;
  order?: number;
  tags?: string[];
};

export function buildEmojiIndex(
  rows: readonly CompactRow[],
  shortcodes: Record<string, string | string[]>
): EmojiIndex {
  const entries: EmojiEntry[] = [];
  const sorted = [...rows]
    .filter((r) => r.group !== undefined && r.group !== 2)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const row of sorted) {
    const emoji = canonicalEmoji(row.unicode);
    if (!emoji) continue;
    const codes = shortcodes[row.hexcode];
    entries.push({
      emoji,
      label: row.label,
      shortcodes: codes === undefined ? [] : Array.isArray(codes) ? codes : [codes],
      tags: row.tags ?? [],
      group: row.group!,
    });
  }
  const groups = GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    entries: entries.filter((e) => e.group === g.id),
  })).filter((g) => g.entries.length > 0);
  return { entries, groups };
}

let loading: Promise<EmojiIndex> | null = null;

/** The emoji index, loaded once (its own chunk). */
export function loadEmojiIndex(): Promise<EmojiIndex> {
  loading ??= Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/github.json'),
  ])
    .then(([compact, github]) =>
      buildEmojiIndex(
        compact.default as unknown as CompactRow[],
        github.default as unknown as Record<string, string | string[]>
      )
    )
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/**
 * Emoji matching what's typed in the picker's search: a shortcode or name
 * that starts with it first, then a tag, then anywhere in the name.
 */
export function searchEmoji(index: EmojiIndex, query: string, limit = 120): EmojiEntry[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const rank = (e: EmojiEntry): number => {
    if (e.shortcodes.some((s) => s === q)) return 0;
    if (e.shortcodes.some((s) => s.startsWith(q))) return 1;
    const label = e.label.toLowerCase();
    if (label.startsWith(q) || label.split(/[\s:-]+/).some((w) => w.startsWith(q))) return 2;
    if (e.tags.some((t) => t.startsWith(q))) return 3;
    if (label.includes(q) || e.shortcodes.some((s) => s.includes(q))) return 4;
    return -1;
  };
  return index.entries
    .map((entry, order) => ({ entry, order, rank: rank(entry) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.entry);
}

/** The composer's `:` menu: emoji whose shortcode starts with (then contains) what's typed, each with the shortcode that matched. */
export function matchShortcodes(
  index: EmojiIndex,
  query: string,
  limit = 8
): Array<{ entry: EmojiEntry; shortcode: string }> {
  const q = query.toLowerCase();
  const prefix: Array<{ entry: EmojiEntry; shortcode: string }> = [];
  const inner: Array<{ entry: EmojiEntry; shortcode: string }> = [];
  for (const entry of index.entries) {
    const starts = entry.shortcodes.find((s) => s.startsWith(q));
    if (starts) prefix.push({ entry, shortcode: starts });
    else {
      const has = entry.shortcodes.find((s) => s.includes(q));
      if (has) inner.push({ entry, shortcode: has });
    }
  }
  // An exact match first (":tada" → 🎉 before 🎋 :tanabata_tree:), then shorter shortcodes.
  prefix.sort(
    (a, b) =>
      Number(b.shortcode === q) - Number(a.shortcode === q) ||
      a.shortcode.length - b.shortcode.length
  );
  return [...prefix, ...inner].slice(0, limit);
}

// ────────── "Frequently used": yours, on this computer ──────────

const FREQUENT_KEY = 'rig-emoji-frequent';
const FREQUENT_SHOWN = 8;

function readCounts(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(FREQUENT_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Your most-used emoji (reactions and ones you've put in messages), most used first; the quick five until you've used any. */
export function frequentEmoji(): string[] {
  const counts = Object.entries(readCounts()).filter(([, n]) => typeof n === 'number' && n > 0);
  if (counts.length === 0) return [...QUICK_REACTIONS];
  return counts
    .sort((a, b) => b[1] - a[1])
    .slice(0, FREQUENT_SHOWN)
    .map(([emoji]) => emoji);
}

/** Counts one use of `emoji` toward "Frequently used". */
export function recordEmojiUse(emoji: string): void {
  try {
    const counts = readCounts();
    counts[emoji] = (counts[emoji] ?? 0) + 1;
    localStorage.setItem(FREQUENT_KEY, JSON.stringify(counts));
  } catch {
    // Storage unavailable: the row just stays as it was.
  }
}
