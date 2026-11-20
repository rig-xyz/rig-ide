import { isDotMatrixEnd, type DotMatrixState, type DotMatrixTone } from '@renderer/lib/ui/dot-matrix';
import {
  type RunStartedBy,
  type RunStepKind,
  type SpaceRun,
  type SpaceState,
  type ViewWork,
} from '@shared/rig/space-state';
import {
  viewAtNextMs,
  viewOfRefreshPrompt,
  viewStatusFor,
  type ViewAt,
  type ViewManifest,
} from '@shared/rig/views';

/**
 * Every line of copy and every state decision the tabs rail shows about standing work and turns
 * (spike, Rig Alpha). Pure: the rail draws what these return. The facts come from main
 * (`shared/rig/space-state.ts`); nothing here decides what Claude does.
 */
export type Tone = 'bad' | 'warn';
export type Matrix = { state: DotMatrixState; tone?: DotMatrixTone };

const SEP = ' · ';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** "3 min ago", for how fresh a view's data is. */
export function ago(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** "5m", "23h", "2d": freshness short enough to sit beside a view's own words. */
export function agoShort(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / MINUTE);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A set time in words, on this computer's clock whatever zone it was written in: "every Friday at
 * 15:00", "every weekday at 09:00", "every Mon, Wed and Fri at 09:00", "every day at 09:00".
 */
function atInWords(at: ViewAt, now: number): string {
  // The times it comes up over the next week say which days and what hour those are here.
  const anytime = { ...at, fromMs: null };
  const times: number[] = [];
  for (let t = now, i = 0; i < (at.days?.length ?? 1); i++) times.push((t = viewAtNextMs(anytime, t)));
  const time = clock(times[0]!);
  if (!at.days) return `every day at ${time}`;
  // Monday first, as a week is read.
  const days = [...new Set(times.map((t) => new Date(t).getDay()))].sort(
    (a, b) => ((a + 6) % 7) - ((b + 6) % 7)
  );
  if (days.length === 1) return `every ${WEEKDAYS[days[0]!]} at ${time}`;
  if (days.join() === '1,2,3,4,5') return `every weekday at ${time}`;
  const short = days.map((day) => WEEKDAYS[day]!.slice(0, 3));
  return `every ${short.slice(0, -1).join(', ')} and ${short.at(-1)} at ${time}`;
}

/** How often a schedule runs, in words: its interval, or its set time when it has one. */
export function everyInWords(everyMs: number, at?: ViewAt | null, now = Date.now()): string {
  if (at) return atInWords(at, now);
  const minutes = Math.max(1, Math.round(everyMs / MINUTE));
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? 'every day' : `every ${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }
  return `every ${minutes} min`;
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const pad = (value: number): string => String(value).padStart(2, '0');

/** Local time as HH:MM. */
export function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const startOfDay = (ms: number): number => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

export function nextInWords(nextDueAt: number, now: number): string {
  if (nextDueAt <= now + MINUTE) return 'due now';
  const days = Math.round((startOfDay(nextDueAt) - startOfDay(now)) / DAY);
  if (days <= 0) return `next at ${clock(nextDueAt)}`;
  if (days === 1) return `next tomorrow at ${clock(nextDueAt)}`;
  return `next in ${days} days`;
}

/** When something last happened, as a time today or a day back: "13:00", "yesterday 13:00", "3 days ago". */
export function lastInWords(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return clock(at);
  if (days === 1) return `yesterday ${clock(at)}`;
  return `${days} days ago`;
}

/** How long past its time a view may run before it is said to be waiting on its member's Mac. */
export const OWNER_OVERDUE_GRACE_MS = 3 * MINUTE;
/** A refresh in another member's app that has said nothing for this long is not shown as going: their Mac may have gone. */
export const OWNER_RUN_QUIET_MS = 10 * MINUTE;

/**
 * The last scheduled refresh of a view in the app of the member who runs it, as the Room's run
 * records tell every member: this app cannot see into that Mac, only what its runs reported.
 */
export type OwnerRefresh = {
  state: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  endedAt: number | null;
  /** When the run last reported anything; its start when nothing more is known. */
  lastWordAt: number;
  /** Why it failed, in the run's own words, when it said. */
  reason: string | null;
};

/** The newest scheduled refresh of `view` among the Room's runs owned by `runsAs`. */
export function ownerRefreshOf(input: {
  view: string;
  runsAs: string | null;
  runs: readonly {
    owner: string;
    title: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    lastWordAt?: number | null;
    reason?: string | null;
  }[];
}): OwnerRefresh | null {
  if (!input.runsAs) return null;
  let newest: OwnerRefresh | null = null;
  for (const run of input.runs) {
    if (run.owner !== input.runsAs || viewOfRefreshPrompt(run.title) !== input.view) continue;
    const startedAt = Date.parse(run.startedAt);
    if (!Number.isFinite(startedAt) || (newest && newest.startedAt >= startedAt)) continue;
    const ended = run.endedAt ? Date.parse(run.endedAt) : NaN;
    newest = {
      state:
        run.status === 'failed' ? 'failed' : run.status === 'stopped' ? 'stopped' : run.status === 'done' ? 'done' : 'running',
      startedAt,
      endedAt: Number.isFinite(ended) ? ended : null,
      lastWordAt: Math.max(startedAt, run.lastWordAt ?? 0),
      reason: run.reason?.trim() || null,
    };
  }
  return newest;
}

/**
 * What to say about a view that another member's app keeps fresh, when there is something to say:
 * their refresh is going, their last one failed, or the view is past its time and waits on their
 * Mac. Null while it is simply on schedule.
 */
function ownerLine(input: {
  manifest: ViewManifest;
  runsAsName: string | null;
  ownerRefresh: OwnerRefresh | null;
  now: number;
}): { text: string; short: string; tone?: Tone; going?: boolean } | null {
  const { manifest, runsAsName, ownerRefresh, now } = input;
  if (manifest.everyMs === null) return null;
  // A first name keeps the line inside a narrow rail; an email stands in by its part before the @.
  const first = runsAsName?.trim().split(/[\s@]+/)[0];
  const whose = first ? `${first}'s` : "another member's";
  const updated = manifest.updatedMs;
  const last = updated !== null ? `${SEP}last refresh ${lastInWords(updated, now)}` : '';
  const waiting = { text: `Waiting on ${whose} Mac${last}`, short: `Waiting on ${whose} Mac`, tone: 'warn' as const };
  if (ownerRefresh?.state === 'running') {
    // A run that went quiet is not "going": the Mac may have closed mid-refresh.
    if (now - ownerRefresh.lastWordAt < OWNER_RUN_QUIET_MS) {
      const text = `Refreshing in ${whose} Rig app`;
      return { text, short: text, going: true };
    }
    return waiting;
  }
  const failedSince =
    ownerRefresh?.state === 'failed' &&
    ownerRefresh.endedAt !== null &&
    ownerRefresh.endedAt >= (updated ?? 0);
  if (failedSince) {
    const at = clock(ownerRefresh.endedAt!);
    return {
      text: ownerRefresh.reason
        ? `Refresh failed at ${at}: ${ownerRefresh.reason}`
        : `Refresh failed in ${whose} Rig app at ${at}`,
      short: `${whose} refresh failed at ${at}`.replace(/^./, (c) => c.toUpperCase()),
      tone: 'bad',
    };
  }
  if (updated !== null && now > updated + manifest.everyMs + OWNER_OVERDUE_GRACE_MS) return waiting;
  return null;
}

const STEP_MATRIX: Record<RunStepKind, DotMatrixState> = {
  starting: 'starting',
  thinking: 'thinking',
  reading: 'reading',
  writing: 'editing',
  searching: 'searching',
  running: 'running',
  tool: 'running',
  replying: 'thinking',
};

export function stepMatrix(run: SpaceRun): Matrix {
  if (run.state === 'waiting') return { state: 'waiting', tone: 'warn' };
  return { state: STEP_MATRIX[run.stepKind] };
}

/** Names known before without a schedule that have one now; nothing on the first load. */
export function newlyScheduled(
  prev: ReadonlyMap<string, number | null> | null,
  next: readonly ViewManifest[]
): string[] {
  if (!prev) return [];
  return next
    // Only a view that was already here without a schedule: one that is still loading in, or
    // arrives with its schedule, did not just get one.
    .filter((view) => view.everyMs !== null && prev.has(view.name) && prev.get(view.name) === null)
    .map((view) => view.name);
}

const isActive = (run: SpaceRun): boolean => run.state === 'working' || run.state === 'waiting';

/** The run to show among several: one waiting on the person first, then the latest. */
function pickRun(runs: readonly SpaceRun[]): SpaceRun | undefined {
  return [...runs]
    .filter(isActive)
    .sort(
      (a, b) =>
        Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.startedAt - a.startedAt
    )[0];
}

const viewRun = (runs: readonly SpaceRun[], name: string): SpaceRun | undefined =>
  pickRun(runs.filter((run) => run.view === name));

/** Rig's own regular look over the space, said as what Rig does for the person, and why. */
export const RIG_LOOKS_AFTER = 'Rig is looking after this space';
export const RIG_LOOKS_AFTER_WHY = 'Keeping your tabs and facts up to date';

/** What a pass is for when it has no step worth saying yet. */
const WHY: Record<RunStartedBy, string> = {
  clock: 'Refreshing',
  view: 'Working on it',
  gardener: 'Rig is looking after this space',
  message: 'Replying to you',
  comment: 'Replying to a comment',
};

/** A step that says something: "Reading FACTORY.md", not "Working" or "Starting". */
const stepOf = (run: SpaceRun): string | null =>
  run.step && run.step !== 'Working' && run.step !== 'Starting' ? run.step : null;

const withStep = (lead: string, run: SpaceRun): string => {
  const step = stepOf(run);
  return step ? `${lead}${SEP}${step}` : lead;
};

/**
 * A pass on a view, said on that view's own row or unit: the step it is on. Only a scheduled
 * refresh says why first, since the person did not start it.
 */
const viewRunLine = (run: SpaceRun): string =>
  run.startedBy === 'clock' ? withStep(WHY.clock, run) : (stepOf(run) ?? WHY[run.startedBy]);

const titleOf = (view: ViewManifest): string => view.title ?? view.name;

/** "every hour, next at 15:00"; without the runtime's clock, just "every hour". */
function schedule(
  everyMs: number,
  at: ViewAt | null | undefined,
  work: ViewWork | undefined,
  now: number
): string {
  const every = everyInWords(everyMs, at, now);
  return work && work.nextDueAt !== null ? `${every}, ${nextInWords(work.nextDueAt, now)}` : every;
}

/** The last refresh ended badly and nothing has changed the data since. */
function unresolvedRefresh(work: ViewWork | undefined): ViewWork['lastRefresh'] | null {
  const last = work?.lastRefresh;
  if (!work || !last || last.finishedAt === null) return null;
  if (last.result !== 'failed' && last.result !== 'not_started' && last.result !== 'stopped')
    return null;
  return last.finishedAt >= (work.dataModifiedMs ?? 0) ? last : null;
}

export type RowStatus = {
  text: string;
  /** How old the view's data is ("3m"), shown apart from the text; only at rest. */
  fresh?: string;
  tone?: Tone;
  /** Replaces the row's icon while something is going on. */
  matrix?: Matrix;
  /** The view arrived and has not been looked at: it pops in. */
  arrived?: boolean;
  tooltip: string;
};

export function viewRowStatus(input: {
  manifest: ViewManifest;
  work: ViewWork | undefined;
  runs: readonly SpaceRun[];
  /** The old renderer store says a turn from this view is going (the first instant after a click). */
  turnRunning: boolean;
  unseen: boolean;
  justScheduled: boolean;
  viewerId: string | null;
  /** Name of the member whose Rig app refreshes it, when it is not this one. */
  runsAsName?: string | null;
  /** That member's last scheduled refresh of it, from the Room's runs. */
  ownerRefresh?: OwnerRefresh | null;
  now: number;
}): RowStatus {
  const { manifest, work, runs, turnRunning, unseen, justScheduled, viewerId, now } = input;
  const every = manifest.everyMs;
  const updated = manifest.updatedMs !== null ? ago(manifest.updatedMs, now) : null;
  const tail = every !== null ? `Refreshes ${schedule(every, manifest.at, work, now)}.` : 'No schedule yet.';
  const tooltip = updated ? `Updated ${updated}. ${tail}` : tail;
  const row = (text: string, extra: Partial<RowStatus> = {}): RowStatus => ({
    text,
    tooltip,
    ...extra,
  });

  const run = viewRun(runs, manifest.name);
  if (run?.state === 'waiting')
    return row('Waiting on you', { tone: 'warn', matrix: stepMatrix(run) });
  if (run) return row(viewRunLine(run), { matrix: stepMatrix(run) });
  if (turnRunning) return row('Starting', { matrix: { state: 'starting' } });
  // Someone else set or changed its schedule: nothing runs in this person's Claude until they agree.
  if (work?.needsAccept && every !== null)
    return row(`Refreshes ${everyInWords(every, manifest.at, now)} once you accept`, {
      tone: 'warn',
      tooltip: NEEDS_ACCEPT_WHY,
    });
  if (unseen) {
    return row(
      every !== null ? `Refreshes ${schedule(every, manifest.at, work, now)}` : (manifest.sub ?? 'Just added'),
      { arrived: true }
    );
  }
  if (justScheduled && every !== null) return row(`Now refreshes ${schedule(every, manifest.at, work, now)}`);
  // Another member's app keeps it fresh: say when that app is on it, failed, or is being waited on.
  if (work?.runsHere === false) {
    const owner = ownerLine({
      manifest,
      runsAsName: input.runsAsName ?? null,
      ownerRefresh: input.ownerRefresh ?? null,
      now,
    });
    // The rail is narrow: the row says it short, with the data's age at the right; the whole
    // sentence, with the time of the last refresh, is the tooltip.
    if (owner)
      return row(owner.short, {
        tone: owner.tone,
        tooltip: owner.text,
        ...(manifest.updatedMs !== null && !owner.going ? { fresh: agoShort(manifest.updatedMs, now) } : {}),
        ...(owner.going ? { matrix: { state: 'running' as const, tone: 'mute' as const } } : {}),
      });
  }
  if (manifest.failed) return row(manifest.note ?? "Couldn't refresh", { tone: 'bad' });
  const last = unresolvedRefresh(work);
  if (last?.finishedAt != null) {
    if (last.result === 'stopped')
      return row(`Refresh stopped at ${clock(last.finishedAt)}`, { tone: 'warn' });
    return row(`Last refresh failed at ${clock(last.finishedAt)}`, { tone: 'bad' });
  }
  if (viewStatusFor(manifest, viewerId, now) === 'stale' && updated)
    return row(`Updated ${updated}, overdue`, { tone: 'warn' });
  // At rest the row says what the view holds; how fresh that is sits apart, at the right.
  const fresh = manifest.updatedMs !== null ? agoShort(manifest.updatedMs, now) : undefined;
  const next =
    every !== null && work && work.nextDueAt !== null ? nextInWords(work.nextDueAt, now) : null;
  if (manifest.sub) return row(manifest.sub, { fresh });
  if (fresh) return row(next ? capital(next) : '', { fresh });
  return row('No data yet');
}

/** Why a schedule waits for the person: said on the tab and on the rail's entry. */
export const NEEDS_ACCEPT_WHY =
  'Another member set or changed this schedule. It runs in your Claude only once you accept it.';

/** The standing line for a scheduled view in the Running section (and its status grid). */
export type EntryStatus = {
  text: string;
  tone?: Tone;
  matrix: Matrix;
  arrived?: boolean;
};

export function standingLine(input: {
  manifest: ViewManifest;
  work: ViewWork | undefined;
  runs: readonly SpaceRun[];
  turnRunning: boolean;
  justScheduled: boolean;
  /** Name of the member whose Rig app refreshes it, when it is not this one. */
  runsAsName: string | null;
  /** That member's last scheduled refresh of it, from the Room's runs. */
  ownerRefresh?: OwnerRefresh | null;
  now: number;
}): EntryStatus {
  const { manifest, work, runs, turnRunning, justScheduled, runsAsName, now } = input;
  const everyMs = manifest.everyMs ?? 0;
  const every = everyInWords(everyMs, manifest.at, now);
  const Every = capital(every);
  // Scheduled and at rest: the grid idles, ready to wake.
  const queued: Matrix = { state: 'standby', tone: 'mute' };
  const next = work && work.nextDueAt !== null ? nextInWords(work.nextDueAt, now) : null;

  const run = viewRun(runs, manifest.name);
  if (run?.state === 'waiting')
    return { text: 'Waiting on you', tone: 'warn', matrix: stepMatrix(run) };
  if (run) return { text: viewRunLine(run), matrix: stepMatrix(run) };
  if (turnRunning) return { text: 'Starting', matrix: { state: 'starting' } };
  if (work?.runsHere === false) {
    const owner = ownerLine({ manifest, runsAsName, ownerRefresh: input.ownerRefresh ?? null, now });
    if (owner) return { text: owner.text, tone: owner.tone, matrix: queued };
    return {
      text: `${Every}, in ${runsAsName ? `${runsAsName}'s` : "another member's"} Rig app`,
      matrix: queued,
    };
  }
  if (work?.needsAccept) return { text: `${Every}, once you accept`, tone: 'warn', matrix: queued };
  if (justScheduled) {
    return {
      text: `Now refreshes ${schedule(everyMs, manifest.at, work, now)}`,
      // The same quiet grid as any loop at rest; that it is new shows in how it arrives.
      matrix: queued,
      arrived: true,
    };
  }
  if (work?.skipped?.reason === 'busy')
    return { text: 'Due now, after the current work finishes', matrix: queued };
  if (work?.skipped?.reason === 'queued')
    return { text: 'Due now, after another view refreshes', matrix: queued };
  const last = unresolvedRefresh(work);
  if (last?.finishedAt != null) {
    const at = clock(last.finishedAt);
    const dueAt = work?.nextDueAt ?? 0;
    const retry = dueAt > now ? `at ${clock(dueAt)}` : 'now';
    if (last.result === 'failed')
      return {
        text: `Refresh failed at ${at}, next try ${retry}`,
        tone: 'bad',
        matrix: { state: 'failed' },
      };
    if (last.result === 'not_started')
      return {
        text: `Couldn't start a refresh at ${at}, next try ${retry}`,
        tone: 'bad',
        matrix: { state: 'failed' },
      };
    return {
      text: next ? `Refresh stopped at ${at}, ${next}` : `Refresh stopped at ${at}`,
      matrix: { state: 'stopped' },
    };
  }
  if (!work) return { text: `${Every}, while Rig is open`, matrix: queued };
  if (manifest.updatedMs === null) return { text: `${Every}, first refresh soon`, matrix: queued };
  return {
    text: next
      ? `Updated ${ago(manifest.updatedMs, now)}, ${next}`
      : `Updated ${ago(manifest.updatedMs, now)}`,
    matrix: queued,
  };
}

/** The Room row's second line, and the grid at its right. */
export function roomRowStatus(input: {
  runs: readonly SpaceRun[];
  /** Views the old renderer store knows a turn is going for. */
  viewTurns: readonly string[];
  views: readonly ViewManifest[];
}): { text: string; tone?: Tone; matrix?: Matrix } {
  const { runs, viewTurns, views } = input;
  const run = pickRun(runs);
  if (run?.state === 'waiting')
    return { text: 'Waiting on you', tone: 'warn', matrix: stepMatrix(run) };
  if (run) {
    const view = views.find((v) => v.name === run.view);
    const name = view ? titleOf(view) : (run.view ?? 'a view');
    const text =
      run.startedBy === 'view'
        ? `Working on ${name}`
        : run.startedBy === 'clock'
          ? `Refreshing ${name}`
          : run.startedBy === 'gardener'
            ? // The Room's row is narrow: the same words, short enough to fit it.
              'Rig is looking after it'
            : (stepOf(run) ?? WHY[run.startedBy]);
    return { text, matrix: stepMatrix(run) };
  }
  if (viewTurns.length > 0)
    return { text: 'Claude is working', matrix: { state: 'thinking' } };
  return { text: '' };
}

export type AgentEntry = {
  key: string;
  agent: 'claude' | 'codex';
  /** Belongs to the person looking, not to another member. */
  mine: boolean;
  state: DotMatrixState;
  label: string;
};

export type RunningEntryData = {
  key: string;
  label: string;
  sub?: string;
  subTone?: Tone;
  matrix: DotMatrixState;
  matrixTone?: DotMatrixTone;
  arrived?: boolean;
  tooltip?: string;
  /** A scheduled view at rest: pressing "Run now" on the entry runs it at once. */
  runNow?: string;
  /** A view whose schedule waits for this person: pressing "Accept" on the entry agrees to it. */
  accept?: string;
};

/** "In 13 h, at 00:20": how far off a scheduled run is, then the time on the clock. */
export function untilInWords(nextDueAt: number, now: number): string {
  const minutes = Math.round((nextDueAt - now) / MINUTE);
  if (minutes <= 1) return 'Due now';
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `In ${hours} h, at ${clock(nextDueAt)}`;
  return `In ${Math.round(hours / 24)} days`;
}

/** What a run of an agent is for, in one line: "Claude is replying", "Working on Drafts to review". */
function runLabel(run: SpaceRun, views: readonly ViewManifest[], agent: string): string {
  const view = views.find((v) => v.name === run.view);
  const name = view ? titleOf(view) : (run.view ?? 'a view');
  switch (run.startedBy) {
    case 'clock':
      return `Refreshing ${name}`;
    case 'view':
      return `Working on ${name}`;
    case 'gardener':
      return RIG_LOOKS_AFTER;
    case 'comment':
      return `${agent} is replying to a comment`;
    default:
      return `${agent} is replying`;
  }
}

/**
 * What the foot of the tabs rail says: is anything happening, and does it need the person. One
 * entry per pass going right now (a pass that waits on the person first). Schedules at rest are
 * not listed; with nothing going, one entry says what runs next. Nothing going and nothing
 * scheduled: no entries, and the rail shows no section.
 */
export function runningEntries(input: {
  views: readonly ViewManifest[];
  state: SpaceState | null;
  agents: readonly AgentEntry[];
  agentName: Record<'claude' | 'codex', string>;
  /** Views the old renderer store knows a turn is going for. */
  viewTurns: readonly string[];
  justScheduled: ReadonlySet<string>;
  members: readonly { id: string; name: string }[] | undefined;
  now: number;
}): RunningEntryData[] {
  const { views, state, agents, agentName, now } = input;
  const runs = state?.runs ?? [];
  const entries: RunningEntryData[] = [];
  const own = (agent: 'claude' | 'codex') => pickRun(runs.filter((run) => run.agent === agent));
  const ofRun = (key: string, run: SpaceRun, tooltip?: string): RunningEntryData => {
    const match = stepMatrix(run);
    if (run.state === 'waiting') {
      const view = views.find((v) => v.name === run.view);
      return {
        key,
        label: `${agentName[run.agent]} needs you`,
        sub: view ? `In ${titleOf(view)}` : (stepOf(run) ?? undefined),
        subTone: 'warn',
        matrix: match.state,
        matrixTone: match.tone,
        tooltip,
      };
    }
    return {
      key,
      label: runLabel(run, views, agentName[run.agent]),
      // Rig's own look says why it is here until it has a step to show.
      sub: stepOf(run) ?? (run.startedBy === 'gardener' ? RIG_LOOKS_AFTER_WHY : undefined),
      matrix: match.state,
      matrixTone: match.tone,
      tooltip,
    };
  };

  for (const entry of agents) {
    const run = entry.mine ? own(entry.agent) : undefined;
    if (run) entries.push(ofRun(entry.key, run, entry.label));
    // An agent the Room knows is at work (another member's, or mine before the state says so).
    else if (!isDotMatrixEnd(entry.state))
      entries.push({ key: entry.key, label: entry.label, matrix: entry.state, tooltip: entry.label });
  }
  for (const agent of ['claude', 'codex'] as const) {
    if (agents.some((entry) => entry.mine && entry.agent === agent)) continue;
    const run = own(agent);
    if (run) entries.push(ofRun(`run:${agent}`, run));
  }
  // A schedule someone else set or changed to run in this person's Claude: it waits for them.
  for (const view of views) {
    const work = state?.views.find((w) => w.view === view.name);
    if (!work?.needsAccept || work.everyMs === null) continue;
    entries.push({
      key: `accept:${view.name}`,
      label: `${titleOf(view)}: schedule changed`,
      sub: capital(everyInWords(work.everyMs, work.at, now)),
      subTone: 'warn',
      matrix: 'standby',
      matrixTone: 'mute',
      accept: view.name,
      tooltip: NEEDS_ACCEPT_WHY,
    });
  }
  entries.sort((a, b) => Number(b.subTone === 'warn') - Number(a.subTone === 'warn'));
  if (entries.length > 0) return entries;

  // Nothing going: what runs next, if anything is scheduled to run in this Rig app.
  const next = views
    .filter((view) => view.everyMs !== null)
    .map((view) => ({ view, work: state?.views.find((w) => w.view === view.name) }))
    .filter(({ work }) => work && work.runsHere !== false && !work.needsAccept && work.nextDueAt !== null)
    .sort((a, b) => (a.work!.nextDueAt ?? 0) - (b.work!.nextDueAt ?? 0))[0];
  if (!next) return [];
  return [
    {
      key: `next:${next.view.name}`,
      label: `Next: ${titleOf(next.view)}`,
      sub: untilInWords(next.work!.nextDueAt ?? 0, now),
      matrix: 'standby',
      matrixTone: 'mute',
      runNow: next.view.name,
      tooltip: `Runs ${everyInWords(next.view.everyMs ?? 0, next.view.at, now)}, in your Rig app while it is open.`,
    },
  ];
}
