/**
 * Room themes (rig/docs/room-themes-spec.md §6): what the relay's
 * `GET .../themes` and `GET .../themes/events` answer, parsed defensively
 * (anything malformed is dropped, never thrown), and the `ThemesFetch`
 * envelope that tells "this relay has no themes" apart from a failure.
 * Shared by main's relay client and the renderer's Room state.
 *
 * The relay sends bigints (seqs, event ids) as strings. Event ids are kept
 * as digit strings and compared with `compareEventIds`; seqs become numbers,
 * like every other seq in the Room.
 */

export type ThemeVia = 'reply' | 'run' | 'thread' | 'followed' | 'jev' | 'proposer' | 'gardener';

const VIAS: readonly string[] = [
  'reply',
  'run',
  'thread',
  'followed',
  'jev',
  'proposer',
  'gardener',
];

/** One theme: `count` messages in it, `lastSeq` the seq of its newest message (its `bornSeq` while it has none). */
export type RoomTheme = {
  id: string;
  name: string;
  description: string;
  bornSeq: number;
  count: number;
  lastSeq: number;
};

export type ThemeAssignment = { themeId: string; via: ThemeVia };

/** The snapshot as the relay sends it, shaped. `latestEventId` is where `events?after=` continues. */
export type ThemesSnapshotWire = {
  enabled: boolean;
  themes: RoomTheme[];
  assignments: Record<string, ThemeAssignment>;
  latestEventId: string;
};

export type ThemeEvent =
  | {
      id: string;
      atSeq: number;
      type: 'born';
      themeId: string;
      name: string;
      description: string;
      bornSeq: number;
    }
  | { id: string; atSeq: number; type: 'assign'; messageId: string; themeId: string; via: ThemeVia }
  | { id: string; atSeq: number; type: 'move'; messageId: string; from: string; to: string }
  | {
      id: string;
      atSeq: number;
      type: 'rename';
      themeId: string;
      name: string;
      description: string | null;
    }
  | { id: string; atSeq: number; type: 'merge'; from: string; into: string };

/**
 * One page of events. `nextCursor` is set only when more wait beyond this
 * page. `lastId` is the id of the page's last event as sent, including any
 * this build skipped (an unknown type), so the cursor still moves past them.
 */
export type ThemeEventsPage = {
  events: ThemeEvent[];
  nextCursor: string | null;
  lastId: string | null;
};

/**
 * A relay without the themes routes answers 404: `{ supported: false }`, not
 * an error. Every other failure stays in the surrounding `Result`.
 */
export type ThemesFetch<T> = { supported: true; data: T } | { supported: false };

const DIGITS = /^\d{1,19}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isVia(value: unknown): value is ThemeVia {
  return typeof value === 'string' && VIAS.includes(value);
}

function toSeq(value: unknown): number | null {
  const n =
    typeof value === 'string' && DIGITS.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toEventId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && DIGITS.test(value) ? value : null;
}

/** Numeric order of two event ids (digit strings, up to a bigint). */
export function compareEventIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseTheme(raw: unknown): RoomTheme | null {
  const r = asRecord(raw);
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const bornSeq = toSeq(r.bornSeq) ?? 0;
  const count =
    typeof r.count === 'number' && r.count >= 0 ? Math.floor(r.count) : (toSeq(r.count) ?? 0);
  return {
    id: r.id,
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    bornSeq,
    count,
    lastSeq: toSeq(r.lastSeq) ?? bornSeq,
  };
}

/** `GET .../themes`; null when there's no usable `themes` list or `latestEventId` (a body that isn't the snapshot at all). */
export function parseThemesSnapshot(raw: unknown): ThemesSnapshotWire | null {
  const r = asRecord(raw);
  if (!r) return null;
  const latestEventId = toEventId(r.latestEventId);
  if (latestEventId === null || !Array.isArray(r.themes)) return null;
  const themes = r.themes.map(parseTheme).filter((t): t is RoomTheme => t !== null);
  const assignments: Record<string, ThemeAssignment> = {};
  for (const [messageId, value] of Object.entries(asRecord(r.assignments) ?? {})) {
    const a = asRecord(value);
    if (a && typeof a.themeId === 'string' && isVia(a.via))
      assignments[messageId] = { themeId: a.themeId, via: a.via };
  }
  return { enabled: r.enabled !== false, themes, assignments, latestEventId };
}

function parseEvent(raw: unknown): ThemeEvent | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = toEventId(r.id);
  const p = asRecord(r.payload);
  if (id === null || !p) return null;
  const atSeq = toSeq(r.atSeq) ?? 0;
  switch (r.type) {
    case 'born':
      if (typeof p.themeId !== 'string' || typeof p.name !== 'string') return null;
      return {
        id,
        atSeq,
        type: 'born',
        themeId: p.themeId,
        name: p.name,
        description: typeof p.description === 'string' ? p.description : '',
        bornSeq: toSeq(p.bornSeq) ?? atSeq,
      };
    case 'assign':
      if (typeof p.messageId !== 'string' || typeof p.themeId !== 'string' || !isVia(p.via))
        return null;
      return { id, atSeq, type: 'assign', messageId: p.messageId, themeId: p.themeId, via: p.via };
    case 'move':
      if (typeof p.messageId !== 'string' || typeof p.from !== 'string' || typeof p.to !== 'string')
        return null;
      return { id, atSeq, type: 'move', messageId: p.messageId, from: p.from, to: p.to };
    case 'rename':
      if (typeof p.themeId !== 'string' || typeof p.name !== 'string') return null;
      return {
        id,
        atSeq,
        type: 'rename',
        themeId: p.themeId,
        name: p.name,
        description: typeof p.description === 'string' ? p.description : null,
      };
    case 'merge':
      if (typeof p.from !== 'string' || typeof p.into !== 'string') return null;
      return { id, atSeq, type: 'merge', from: p.from, into: p.into };
    default:
      return null; // a type this build doesn't know: skipped, never an error
  }
}

/** `GET .../themes/events`; null when the body has no `events` list. Events of unknown or malformed shape are dropped. */
export function parseThemeEventsPage(raw: unknown): ThemeEventsPage | null {
  const r = asRecord(raw);
  if (!r || !Array.isArray(r.events)) return null;
  let lastId: string | null = null;
  for (const item of r.events) {
    const id = toEventId(asRecord(item)?.id);
    if (id !== null && (lastId === null || compareEventIds(id, lastId) > 0)) lastId = id;
  }
  return {
    events: r.events.map(parseEvent).filter((e): e is ThemeEvent => e !== null),
    nextCursor: toEventId(r.nextCursor),
    lastId,
  };
}
