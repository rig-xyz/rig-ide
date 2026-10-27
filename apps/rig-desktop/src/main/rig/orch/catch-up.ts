import type { Result } from '@emdash/shared';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import type { OrchAgentState } from '../feed/relay';
import type { RunOptions } from './agent';

/**
 * The morning catch-up: when the app opens or the Mac wakes and Rig last
 * read more than a few hours ago, one short run reads what came in since,
 * and Home shows it as a strip (never the onboarding again). Its events are
 * kept here so a Home that mounts after it began, or just after it ended,
 * still shows it from the start.
 */

/** A catch-up runs when the last read is older than this. */
export const CATCH_UP_AFTER_MS = 3 * 60 * 60_000;
/** It never reads further back than this, however long Rig was away. */
export const CATCH_UP_MAX_DAYS = 14;
/** How long an ended catch-up's events are kept for a Home that mounts late (its "While you were away"). */
const KEEP_ENDED_MS = 2 * 60_000;
export const CATCH_UP_TRIGGER = 'catch-up';

const DAY_MS = 86_400_000;

/**
 * When Rig last read, and where a catch-up reads from: the run notes' cursors
 * (how far each source has been read), else the last noted run. Someone Rig
 * never read for has neither.
 */
export function readWindow(
  state: Pick<OrchAgentState, 'lastRun' | 'cursors'>,
  now: number
): { lastRead: number | null; since: string | null } {
  const times = Object.values(state.cursors)
    .map((c) => Date.parse(c))
    .filter((t) => !Number.isNaN(t));
  const lastRun = state.lastRun ? Date.parse(state.lastRun.at) : NaN;
  const lastRead = times.length ? Math.max(...times) : Number.isNaN(lastRun) ? null : lastRun;
  const from = times.length ? Math.min(...times) : Number.isNaN(lastRun) ? null : lastRun;
  if (lastRead === null || from === null) return { lastRead: null, since: null };
  return { lastRead, since: new Date(Math.max(from, now - CATCH_UP_MAX_DAYS * DAY_MS)).toISOString() };
}

export type CatchUpDeps = {
  state: () => Promise<Result<OrchAgentState, { message: string }>>;
  /** Onboarding is behind them: before it, the first run's Read step does the reading. */
  firstRunDone: () => boolean;
  /** A run going now (any kind): a catch-up doesn't stack on it. */
  running: () => boolean;
  run: (trigger: string, opts: RunOptions) => Promise<Result<unknown, string>>;
  now: () => number;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void };
};

export function createCatchUp(deps: CatchUpDeps) {
  let current: { run: string | null; events: OrchProgressEvent[]; endedAt: number | null } | null = null;
  let deciding = false;

  /** Runs a catch-up if one is due; says why not otherwise. */
  async function maybe(why: string): Promise<'started' | 'not_due' | 'skipped'> {
    if (deciding || deps.running() || !deps.firstRunDone()) return 'skipped';
    deciding = true;
    try {
      const state = await deps.state();
      if (!state.success) return 'skipped';
      const window = readWindow(state.data, deps.now());
      // Never read for: that's the first run's to do, not a catch-up's.
      if (window.lastRead === null || !window.since) return 'skipped';
      if (deps.now() - window.lastRead < CATCH_UP_AFTER_MS) return 'not_due';
      deps.log?.info('Rig catch-up: starting', { why, since: window.since });
      current = { run: null, events: [], endedAt: null };
      void deps.run(CATCH_UP_TRIGGER, { since: window.since });
      return 'started';
    } finally {
      deciding = false;
    }
  }

  /** Every run's progress passes here; the catch-up's own is kept. */
  function record(event: OrchProgressEvent): void {
    if (!current) return;
    if (event.kind === 'start') {
      if (event.trigger !== CATCH_UP_TRIGGER || current.run) return;
      current.run = event.run;
    }
    if (event.run !== current.run) return;
    current.events.push(event);
    if (event.kind === 'end') current.endedAt = deps.now();
  }

  /** The catch-up going now, or just ended, with its events so far; null when there's none to show. */
  function status(): { events: OrchProgressEvent[]; ended: boolean } | null {
    if (!current || !current.run) return null;
    if (current.endedAt !== null && deps.now() - current.endedAt > KEEP_ENDED_MS) return null;
    return { events: [...current.events], ended: current.endedAt !== null };
  }

  return { maybe, record, status };
}
