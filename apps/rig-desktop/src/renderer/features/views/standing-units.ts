import type { DotMatrixState, DotMatrixTone } from '@renderer/lib/ui/dot-matrix';
import type { SpaceRun, SpaceState, ViewWork } from '@shared/rig/space-state';
import type { ViewManifest } from '@shared/rig/views';
import {
  ago,
  everyInWords,
  RIG_LOOKS_AFTER_WHY,
  runningEntries,
  standingLine,
  untilInWords,
  type Tone,
} from './space-status';

/**
 * The space's loops as the pill down the Room's right edge draws them (spike, Rig Alpha): one unit
 * per view that has a schedule or a pass going on it, one for Rig's own look over the space, then
 * one per pass going right now that no view stands for (an answer). A view with no schedule and
 * nothing going is not a loop and has no unit; it is a tab. Pure. What a run or a problem says comes from `space-status.ts`; the lines a
 * view at rest says are here.
 */
export type StandingUnit = {
  key: string;
  /** The view's title, or what the agent is doing ("Claude working"). */
  name: string;
  /** Where it stands: "Refreshing · Reading FACTORY.md", "every hour, next at 15:00". */
  line?: string;
  tone?: Tone;
  matrix: DotMatrixState;
  matrixTone?: DotMatrixTone;
  /** It just got its schedule: it pops in. */
  arrived?: boolean;
  /** The view it stands for, which a press on it opens; null for a pass with no view. */
  view: string | null;
};

/** The pill shows this many; the rest wait behind "+N". */
export const MAX_STANDING_UNITS = 5;

const SEP = ' · ';

const isActive = (run: SpaceRun): boolean => run.state === 'working' || run.state === 'waiting';

/** The last refresh ended badly and nothing has changed the data since (as `space-status.ts` reads it). */
function endedBadly(work: ViewWork | undefined): boolean {
  const last = work?.lastRefresh;
  if (!work || !last || last.finishedAt === null) return false;
  if (last.result !== 'failed' && last.result !== 'not_started' && last.result !== 'stopped')
    return false;
  return last.finishedAt >= (work.dataModifiedMs ?? 0);
}

/** The gardener looks at most this often (`main/rig/gardener`): what its unit says at rest. */
const CHECK_NAME = 'Rig looks after this space';

/** Rig's own look over the space, at rest: when it last looked. */
function checkUnit(state: SpaceState | null, now: number): StandingUnit | null {
  const check = state?.check;
  if (!check) return null;
  const last = check.lastFinishedAt ?? check.lastStartedAt;
  return {
    key: 'check',
    name: CHECK_NAME,
    line:
      last !== null
        ? `${RIG_LOOKS_AFTER_WHY}${SEP}last looked ${ago(last, now)}`
        : RIG_LOOKS_AFTER_WHY,
    matrix: 'standby',
    matrixTone: 'mute',
    view: null,
  };
}

export function standingUnits(input: {
  views: readonly ViewManifest[];
  state: SpaceState | null;
  agentName: Record<'claude' | 'codex', string>;
  /** Views the old renderer store knows a turn is going for. */
  viewTurns: readonly string[];
  justScheduled: ReadonlySet<string>;
  members: readonly { id: string; name: string }[] | undefined;
  now: number;
}): StandingUnit[] {
  const { views, state, viewTurns, justScheduled, members, now } = input;
  const runs = state?.runs ?? [];
  const known = new Set(views.map((view) => view.name));
  const byName = [...views].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const units = byName.flatMap((manifest): StandingUnit[] => {
    const base = {
      key: `view:${manifest.name}`,
      name: manifest.title ?? manifest.name,
      view: manifest.name,
    };
    const work = state?.views.find((view) => view.view === manifest.name);
    const turnRunning = viewTurns.includes(manifest.name);
    const going = turnRunning || runs.some((run) => isActive(run) && run.view === manifest.name);
    const scheduled = manifest.everyMs !== null;
    if (!scheduled && !going) return [];

    const runsAsName =
      work?.runsAs != null ? (members?.find((m) => m.id === work.runsAs)?.name ?? null) : null;
    // What a run, a problem or a schedule that just arrived says, as the rail says it.
    const status = standingLine({
      manifest,
      work,
      runs,
      turnRunning,
      justScheduled: justScheduled.has(manifest.name),
      runsAsName,
      now,
    });
    const unit: StandingUnit = {
      ...base,
      line: status.text,
      tone: status.tone,
      matrix: status.matrix.state,
      matrixTone: status.matrix.tone,
      arrived: status.arrived,
    };
    // Scheduled and at rest, with nothing to report: when it runs, "every hour, next at 15:00".
    const atRest =
      scheduled &&
      !going &&
      work !== undefined &&
      work.runsHere !== false &&
      !justScheduled.has(manifest.name) &&
      work.skipped === null &&
      !endedBadly(work) &&
      manifest.updatedMs !== null;
    if (atRest) {
      const every = everyInWords(manifest.everyMs ?? 0, manifest.at, now);
      // "Every day · in 13 h, at 00:20": how often, then how far off the next run is.
      const Every = every.charAt(0).toUpperCase() + every.slice(1);
      unit.line =
        work.nextDueAt !== null
          ? `${Every}${SEP}${untilInWords(work.nextDueAt, now).replace(/^[A-Z]/, (c) => c.toLowerCase())}`
          : Every;
    }
    return [unit];
  });

  // Rig's own look over the space: its unit at rest, unless that look is the pass going now.
  const checking = runs.some((run) => isActive(run) && run.startedBy === 'gardener');
  const check = checking ? null : checkUnit(state, now);
  if (check) units.push(check);

  // A pass on a view shows on that view's unit. Any other gets its own, said the way the rail
  // says it, one run at a time so two agents working are two units.
  const passes = runs
    .filter((run) => isActive(run) && !(run.view !== null && known.has(run.view)))
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const run of passes) {
    const [entry] = runningEntries({
      ...input,
      views: [],
      state: state ? { ...state, runs: [run] } : null,
      viewTurns: [],
      agents: [],
    });
    if (!entry) continue;
    units.push({
      key: `run:${run.runId}`,
      name: entry.label,
      line: entry.sub,
      tone: entry.subTone,
      matrix: entry.matrix,
      matrixTone: entry.matrixTone,
      view: null,
    });
  }
  return units;
}

/** What the pill shows and how many it leaves out. A unit waiting on the person is never left out. */
export function fitStandingUnits(
  units: readonly StandingUnit[],
  max: number = MAX_STANDING_UNITS
): { shown: StandingUnit[]; more: StandingUnit[] } {
  if (units.length <= max) return { shown: [...units], more: [] };
  const urgent = (unit: StandingUnit): boolean =>
    (unit.matrix === 'waiting' && unit.matrixTone === 'warn') || unit.tone === 'bad';
  const ranked = [...units].sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
  const keep = new Set(ranked.slice(0, max));
  return {
    shown: units.filter((unit) => keep.has(unit)),
    more: units.filter((unit) => !keep.has(unit)),
  };
}

/** A unit in one line, for a screen reader and for the "+N" list. */
export function unitLabel(unit: StandingUnit): string {
  return unit.line ? `${unit.name}${SEP}${unit.line}` : unit.name;
}
