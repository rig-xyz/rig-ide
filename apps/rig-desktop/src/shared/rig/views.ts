/**
 * Rig views (spike, behind Rig Alpha): a page an agent writes into a space at
 * `views/<name>/index.html` with its data beside it in `data.json`. The app
 * shows it as a tab in a sandboxed frame (`renderer/features/views`), and the
 * only thing the page can send back is an action, checked here on both sides
 * of the bridge.
 */
import type { RigFileNode } from './files';

export const VIEWS_DIR = 'views';
const VIEW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isViewName(name: string): boolean {
  return VIEW_NAME.test(name);
}

export function viewIndexPath(name: string): string {
  return `${VIEWS_DIR}/${name}/index.html`;
}

export function viewDataPath(name: string): string {
  return `${VIEWS_DIR}/${name}/data.json`;
}

/** `views/<name>/index.html` (relative to the space folder) is a view's page; anything else is not. */
export function viewNameFromPath(relPath: string): string | null {
  const parts = relPath.split('/');
  if (parts.length !== 3 || parts[0] !== VIEWS_DIR || parts[2] !== 'index.html') return null;
  return isViewName(parts[1]) ? parts[1] : null;
}

/** The space's views, from its file listing: every folder under `views/` that holds an `index.html`. */
export function viewNamesFromListing(nodes: readonly RigFileNode[]): string[] {
  const dir = nodes.find((node) => node.kind === 'dir' && node.name === VIEWS_DIR);
  const names: string[] = [];
  for (const child of dir?.children ?? []) {
    if (child.kind !== 'dir' || !isViewName(child.name)) continue;
    if (child.children?.some((file) => file.kind === 'file' && file.name === 'index.html')) {
      names.push(child.name);
    }
  }
  return names.sort();
}

/** What a view may send: an intent and a flat set of text fields. */
export type RigViewAct = { intent: string; payload: Record<string, string> };

export const VIEW_ACT_MAX_BYTES = 4096;
const INTENT = /^[a-z][a-z0-9_.-]{0,63}$/i;

/**
 * Whether a message from a view's page came with a real press or key (the browser's own record of
 * it, which a page cannot make up). A view's page is a synced file any member can change, so a
 * choice only starts a turn in the viewer's session, and a link only opens, when the viewer
 * themselves did something: never from a page that sends by itself on load or on a timer.
 */
export function viewMessageHasGesture(event: object): boolean {
  // `MessageEvent.userActivation` is not in every DOM typing, so it is read as a plain field.
  const activation = (event as { userActivation?: { isActive?: unknown } | null }).userActivation;
  return activation?.isActive === true;
}

/** Why a `rig:act` message is refused, or null when it is well formed. Same rules as the host spike. */
export function checkViewAct(message: { intent?: unknown; payload?: unknown }): string | null {
  if (typeof message.intent !== 'string' || !INTENT.test(message.intent)) return 'bad intent';
  const payload = message.payload ?? {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return 'bad payload';
  for (const value of Object.values(payload)) {
    if (typeof value !== 'string') return 'payload values must be text';
  }
  if (JSON.stringify(payload).length > VIEW_ACT_MAX_BYTES) return 'payload too large';
  return null;
}

/** The turn a view action starts in the member's own space session. Its first line is what the Room shows. */
export function viewActPrompt(spec: {
  view: string;
  person: string;
  intent: string;
  payload: Record<string, string>;
}): string {
  const lines = Object.entries(spec.payload).map(
    ([key, value]) => `- ${key}: ${value.replace(/\s+/g, ' ').trim()}`
  );
  const withLines = lines.length ? ` with:\n${lines.join('\n')}\n` : '. ';
  return `From the "${spec.view}" view, ${spec.person} chose "${spec.intent}"${withLines}Decide what to do under this space's rules.`;
}

/**
 * What the session is told, out of the Room's sight, with every turn a view starts: where the view
 * lives and that the turn is not over until the view says what happened. Without it the choice is
 * taken and the card that offered it sits there unchanged.
 */
export function viewTurnContext(view: string): string {
  return [
    `This turn was started by the "${view}" view of this space: ${viewIndexPath(view)} is its page and ${viewDataPath(view)} is the data it shows.`,
    `Before you finish, rewrite ${viewDataPath(view)} so the view shows where things stand now: a step that was taken leaves the list or says what came of it, and anything new that needs a person is added as a step.`,
    'Write the whole file at once with your file-writing tool, not a shell command, and keep it valid JSON. That one write needs no approval; the open view updates as soon as the file changes.',
    "Anything that reaches outside this space (posting, sending, changing another system) stays a step for a person to choose unless this space's rules say you may do it.",
  ].join('\n');
}

export function viewMetaPath(name: string): string {
  return `${VIEWS_DIR}/${name}/view.json`;
}

/** The shortest gap a view may ask for between refreshes. */
export const VIEW_REFRESH_MIN_MS = 5 * 60_000;

/**
 * A set time for a schedule, as `view.json` writes it in `"at"` (with `"tz"` and `"from"`):
 * "every Friday at 15:00, New York time, from the 27th".
 */
export type ViewAt = {
  /** The days of the week it runs, 0 for Sunday, in order; null for every day. */
  days: number[] | null;
  /** Minutes after midnight, in `tz`. */
  minute: number;
  /** An IANA zone ("America/New_York"); null for the zone of the Mac that runs it. */
  tz: string | null;
  /** No pass before this day starts, in `tz`; null when it starts at once. */
  fromMs: number | null;
};

/**
 * When a view's data is refreshed without anyone asking, as the agent that made the view wrote it
 * in `view.json`. Nobody configures this by hand.
 *   "every":   "30m" | "2h" | "1d"  — how old the data may get
 *   "at":      "fri 15:00" | "09:00" | "mon,wed,fri 09:00" | "weekdays 09:00" — a set time instead
 *              of an interval, with "tz" (an IANA zone) and "from" ("2026-11-27": not before that day)
 *   "runs_as": "usr_…"              — whose session does the refresh (the member the view was made with)
 *   "refresh": free text            — what a refresh should do, passed to the session as is
 * With `at`, `everyMs` is the longest gap between two of its passes (a week, for one day a week).
 */
export type ViewSchedule = {
  everyMs: number;
  at: ViewAt | null;
  runsAs: string;
  refresh: string | null;
};

const DAY_MS = 86_400_000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function isZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day a moment falls on, in a zone (null: this computer's own). */
function wallDay(ms: number, tz: string | null): { y: number; m: number; d: number } {
  if (tz === null) {
    const date = new Date(ms);
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(ms);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: part('year'), m: part('month'), d: part('day') };
}

/** How far a zone's clock is ahead of UTC at a moment, in ms. */
function zoneOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The moment a zone's clock reads this day and time (null: this computer's own zone). */
function wallToMs(y: number, m: number, d: number, minute: number, tz: string | null): number {
  if (tz === null) return new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60).getTime();
  const asUtc = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  // The offset at the guess, then at the answer: they differ only across a clock change.
  const first = asUtc - zoneOffsetMs(asUtc, tz);
  return asUtc - zoneOffsetMs(first, tz);
}

/** `"at"`, `"tz"` and `"from"` of a `view.json`; null when `"at"` does not say a time, or the zone is not one. */
export function parseViewAt(at: unknown, tz: unknown, from: unknown): ViewAt | null {
  if (typeof at !== 'string') return null;
  const match = /^(?:(.*?)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(at.trim());
  if (!match) return null;
  let hour = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  const half = match[4]?.toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minutes > 59) return null;

  const words = (match[1] ?? '').toLowerCase().replace(/\b(every|on|and|at)\b/g, ' ');
  const days = new Set<number>();
  for (const word of words.split(/[\s,]+/).filter(Boolean)) {
    if (word === 'day' || word === 'daily') continue;
    if (word === 'weekdays' || word === 'weekday') [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    else if (word === 'weekends' || word === 'weekend') [0, 6].forEach((d) => days.add(d));
    else {
      const day = DAY_NAMES.indexOf(word.slice(0, 3));
      // "fri", "friday", "fridays": a day's name, whole or cut to three letters.
      if (day < 0 || !/^[a-z]{3,9}$/.test(word)) return null;
      days.add(day);
    }
  }

  const zone = typeof tz === 'string' && tz.trim() ? tz.trim() : null;
  if (zone !== null && !isZone(zone)) return null;
  let fromMs: number | null = null;
  if (typeof from === 'string' && from.trim()) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from.trim());
    if (!date) return null;
    fromMs = wallToMs(Number(date[1]), Number(date[2]), Number(date[3]), 0, zone);
  }
  return {
    days: days.size === 0 || days.size === 7 ? null : [...days].sort((a, b) => a - b),
    minute: hour * 60 + minutes,
    tz: zone,
    fromMs,
  };
}

/** The first time a set-time schedule comes up after a moment. */
export function viewAtNextMs(at: ViewAt, afterMs: number): number {
  const after = at.fromMs !== null ? Math.max(afterMs, at.fromMs - 1) : afterMs;
  const start = wallDay(after, at.tz);
  for (let ahead = 0; ahead <= 7; ahead++) {
    // The calendar day `ahead` days on (a month's end rolls over), read back as plain numbers.
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + ahead));
    if (at.days && !at.days.includes(day.getUTCDay())) continue;
    const ms = wallToMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), at.minute, at.tz);
    if (ms > after) return ms;
  }
  return after + 7 * DAY_MS;
}

/** The longest gap between two passes of a set-time schedule: a day, or up to a week. */
function viewAtPeriodMs(at: ViewAt): number {
  if (!at.days) return DAY_MS;
  let longest = 0;
  at.days.forEach((day, i) => {
    const next = at.days![(i + 1) % at.days!.length]!;
    longest = Math.max(longest, ((next - day + 7) % 7 || 7) * DAY_MS);
  });
  return longest;
}

export function parseViewSchedule(text: string): ViewSchedule | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { every, at: atText, tz, from, runs_as: runsAs, refresh } = raw as Record<string, unknown>;
  if (typeof runsAs !== 'string' || !/^usr_[a-z0-9]+$/i.test(runsAs)) return null;
  const words = typeof refresh === 'string' && refresh.trim() ? refresh.trim().slice(0, 2000) : null;
  // A set time, when one is written, is the schedule; a time that cannot be read is no schedule
  // at all, never a fallback to an interval nobody asked for.
  if (atText !== undefined && atText !== null) {
    const at = parseViewAt(atText, tz, from);
    return at ? { everyMs: viewAtPeriodMs(at), at, runsAs, refresh: words } : null;
  }
  if (typeof every !== 'string') return null;
  const match = /^(\d{1,4})\s*(m|h|d)$/i.exec(every.trim());
  if (!match) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2].toLowerCase() as 'm' | 'h' | 'd'
  ];
  const everyMs = Math.max(Number(match[1]) * unit, VIEW_REFRESH_MIN_MS);
  return { everyMs, at: null, runsAs, refresh: words };
}

/**
 * What a member agrees to when a schedule runs in their session: how often or at what time, and
 * the words their session is given. Two schedules with the same signature are the same agreement,
 * so a rename or a new icon in `view.json` changes nothing; a new interval, a new time or new
 * refresh words do.
 */
export function viewScheduleSignature(
  schedule: Pick<ViewSchedule, 'everyMs' | 'refresh'> & { at?: ViewAt | null }
): string {
  const base = `${schedule.everyMs}\n${schedule.refresh ?? ''}`;
  const at = schedule.at;
  if (!at) return base;
  return `${base}\n${at.days?.join(',') ?? '*'} ${at.minute} ${at.tz ?? ''} ${at.fromMs ?? ''}`;
}

const VIEW_META_PATH = /(?:^|[\\/])views[\\/]([a-z0-9][a-z0-9_-]{0,63})[\\/]view\.json$/i;

/**
 * The `view.json` files a tool call of a session wrote, from the diffs the agent's file tools
 * report (`content: [{ type: 'diff', path, newText }]`). A read, a search or a shell command
 * reports no diff, so none of those count. `schedule` is what the write put there when the diff
 * holds the whole file; null when it holds only the changed part. Used only to tell a schedule
 * this Mac's own session just wrote from one that arrived by sync.
 */
export function viewMetasWrittenBy(
  update: Record<string, unknown>
): { view: string; schedule: ViewSchedule | null }[] {
  const content = update.content;
  if (!Array.isArray(content)) return [];
  const written: { view: string; schedule: ViewSchedule | null }[] = [];
  for (const item of content as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { type, path, newText } = item as { type?: unknown; path?: unknown; newText?: unknown };
    if (type !== 'diff' || typeof path !== 'string') continue;
    const match = VIEW_META_PATH.exec(path);
    if (!match) continue;
    written.push({
      view: match[1],
      schedule: typeof newText === 'string' ? parseViewSchedule(newText) : null,
    });
  }
  return written;
}

/**
 * Whether a view's scheduled pass is due. The interval counts from the last pass this app started
 * (`lastStartedMs`: by the clock or "Run now", kept across restarts), never from the data file once
 * a pass is on record: a button pressed in the view rewrites the data file too, and that must not
 * put the pass off. With no pass on record (a view that came from elsewhere, or a first run) the
 * data file's age stands in.
 */
export function isViewRefreshDue(spec: {
  everyMs: number;
  at?: ViewAt | null;
  dataModifiedMs: number | null;
  lastStartedMs: number | null;
  now: number;
}): boolean {
  return spec.now >= viewNextDueMs(spec);
}

/**
 * When a scheduled view is next due; 0 when it is due now and has never been tried. A set time
 * comes up the first time after the last pass (or, with none on record, after the data was last
 * written): a time missed while the app was closed is due as soon as it opens.
 */
export function viewNextDueMs(spec: {
  everyMs: number;
  at?: ViewAt | null;
  dataModifiedMs: number | null;
  lastStartedMs: number | null;
}): number {
  const since = spec.lastStartedMs ?? spec.dataModifiedMs;
  if (spec.at) {
    if (since !== null) return viewAtNextMs(spec.at, since);
    return spec.at.fromMs !== null ? viewAtNextMs(spec.at, spec.at.fromMs - 1) : 0;
  }
  return since === null ? 0 : since + spec.everyMs;
}

export function viewRefreshPrompt(
  view: string,
  schedule: Pick<ViewSchedule, 'refresh'> & Partial<ViewSchedule>
): string {
  const what = schedule.refresh ? ` ${schedule.refresh}` : '';
  return `Scheduled refresh of the "${view}" view.${what}`;
}

/** The view a run's first words say it refreshes on schedule (`viewRefreshPrompt`), or null for any other run. */
export function viewOfRefreshPrompt(prompt: string): string | null {
  const match = /^Scheduled refresh of the "([^"]{1,64})" view\./.exec(prompt);
  return match && isViewName(match[1]) ? match[1] : null;
}

/**
 * The address a view may ask Rig to open in the person's browser: a plain web link and nothing
 * else (no files, no app schemes, no credentials in it). Null for anything it will not open.
 */
export function viewLinkToOpen(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/**
 * A view's manifest: what it declares about itself so Rig can draw its own chrome (the tab list,
 * later the dock and notifications) without running the page. Only the page body is code.
 *
 * It is read from two files, because the two halves change at different speeds:
 *   `view.json`, written once   — `kind`, `icon`, `order`, `title`, `made_for`, `sources`, and the schedule (`every` or `at`, `runs_as`, `refresh`)
 *   `data.json`'s `tab`, written on every refresh — `sub`, `count`, `status`, `note`
 * and Rig fills in the rest itself: when the data last changed, and who is looking.
 */
export const VIEW_KINDS = ['queue', 'board', 'intake', 'feed', 'prs', 'tracker', 'page'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type ViewManifest = {
  name: string;
  /** What kind of view it is, for its icon. `page` when it says nothing or something unknown. */
  kind: ViewKind;
  /** The view's own icon: a Lucide icon name ("pen-line"), chosen by whoever made the view. */
  icon: string | null;
  /** Where its tab sits among the space's tabs by default, lowest first; null when it says nothing. */
  order: number | null;
  title: string | null;
  /** Where things stand, in a few words. */
  sub: string | null;
  /** How many items wait on a person: one number for everyone, or one per member by relay id. */
  counts: number | Record<string, number> | null;
  /** The view's last refresh could not read what it needed. */
  failed: boolean;
  /** One line on why, when it failed. */
  note: string | null;
  /** When its data last changed on disk. */
  updatedMs: number | null;
  /** How old its data may get, as written (`"30m"`) and in ms; null when it only refreshes on request. */
  every: string | null;
  everyMs: number | null;
  /** The set time it refreshes at, when its schedule is one; absent or null for an interval or no schedule. */
  at?: ViewAt | null;
};

/** A Lucide icon name as written in `view.json`: "pen-line", "PenLine" and "pen_line" all read as "pen-line". */
function iconName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 40 ? name : null;
}

const shortText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const wholeCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 999)
    : null;

export function readViewManifest(spec: {
  name: string;
  /** `view.json`'s text, or null when there is none. */
  meta: string | null;
  /** `data.json`'s text, or null when it is missing, too large or half-written. */
  data: string | null;
  dataModifiedMs: number | null;
}): ViewManifest {
  const meta = parseObject(spec.meta);
  const data = parseObject(spec.data);
  const tab =
    data?.tab && typeof data.tab === 'object' && !Array.isArray(data.tab)
      ? (data.tab as Record<string, unknown>)
      : null;
  const schedule = spec.meta ? parseViewSchedule(spec.meta) : null;
  // `badge` is the first name this had; a view written then still counts.
  const rawCount = tab?.count ?? tab?.badge;
  let counts: ViewManifest['counts'] = null;
  if (rawCount && typeof rawCount === 'object' && !Array.isArray(rawCount)) {
    const perPerson: Record<string, number> = {};
    for (const [id, value] of Object.entries(rawCount)) {
      const n = wholeCount(value);
      if (n !== null && /^usr_[a-z0-9]+$/i.test(id)) perPerson[id] = n;
    }
    counts = perPerson;
  } else {
    counts = wholeCount(rawCount);
  }
  // The queue template's file is `review-queue`, and agents write that: it is the same kind.
  const rawKind = typeof meta?.kind === 'string' ? meta.kind.trim().toLowerCase() : '';
  const kind = rawKind === 'review-queue' ? 'queue' : rawKind;
  return {
    name: spec.name,
    kind: (VIEW_KINDS as readonly string[]).includes(kind) ? (kind as ViewKind) : 'page',
    icon: iconName(meta?.icon),
    order: typeof meta?.order === 'number' && Number.isFinite(meta.order) ? meta.order : null,
    title: shortText(meta?.title, 60),
    sub: shortText(tab?.sub, 48),
    counts,
    failed: tab?.status === 'failed',
    note: shortText(tab?.note, 120),
    updatedMs: spec.dataModifiedMs,
    every: schedule ? shortText(meta?.every, 12) : null,
    everyMs: schedule?.everyMs ?? null,
    at: schedule?.at ?? null,
  };
}

/** How many of the view's items wait on this person. */
export function viewCountFor(manifest: ViewManifest, viewerId: string | null): number {
  if (manifest.counts === null) return 0;
  if (typeof manifest.counts === 'number') return manifest.counts;
  return viewerId ? (manifest.counts[viewerId] ?? 0) : 0;
}

/**
 * Where a view stands for one person, worst first: its refresh failed; something in it waits on
 * them; it refreshes itself but its data is more than two periods old; or all is well.
 */
export type ViewStatus = 'failed' | 'needs_you' | 'stale' | 'ok';

export function viewStatusFor(
  manifest: ViewManifest,
  viewerId: string | null,
  now: number
): ViewStatus {
  if (manifest.failed) return 'failed';
  if (viewCountFor(manifest, viewerId) > 0) return 'needs_you';
  if (
    manifest.everyMs !== null &&
    manifest.updatedMs !== null &&
    now - manifest.updatedMs > 2 * manifest.everyMs + 60_000
  ) {
    return 'stale';
  }
  return 'ok';
}
