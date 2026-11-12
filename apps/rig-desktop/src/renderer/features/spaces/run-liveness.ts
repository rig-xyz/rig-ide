import type { SessionCard, SessionRunMeta, SessionStatus } from './types';

/**
 * Whether a run the relay still shows going is really going. The owner's own
 * app ends a turn that has said nothing for 30 minutes (main `dispatch.ts`,
 * `RUN_STALL_MS`), checking every minute: a run quiet past this is one no app
 * is running any more (its owner's app quit, slept for good, or lost it), and
 * nothing else will ever end it. Its card stops saying "Thinking".
 */
export const RUN_QUIET_MS = 45 * 60_000;

/**
 * For a run with no event times to go on (only when it started: the sidebar's
 * space status, a run with no events yet), a run this old with no end is taken
 * for stalled. No agent turn runs this long; a short guess would call a
 * working run dead.
 */
export const RUN_UNHEARD_MS = 6 * 60 * 60_000;

/**
 * An approval left unanswered this long is said as such: the run waits on its
 * owner (an approval is never timed out by their app), maybe for good.
 */
export const APPROVAL_STALE_MS = 24 * 60 * 60_000;

/**
 * - `live`: going, or too recent to say otherwise.
 * - `waiting`: on its owner's approval since `since`; `stale` once that's a day.
 * - `stalled`: nothing since `since` for longer than any working run goes quiet.
 */
export type RunLiveness =
  | { kind: 'live' }
  | { kind: 'waiting'; since: number; stale: boolean }
  | { kind: 'stalled'; since: number };

export type RunClock = {
  status: SessionStatus;
  startedAt: string;
  /** When the relay stored its latest event; null when that isn't known. */
  lastEventAt: number | null;
  /** When the approval it waits on was asked; null when it waits on none. */
  pendingSince: number | null;
};

/** Null for a run that has ended. */
export function runLiveness(run: RunClock, now: number): RunLiveness | null {
  if (run.status !== 'running' && run.status !== 'waiting') return null;
  if (run.pendingSince !== null) return { kind: 'waiting', since: run.pendingSince, stale: now - run.pendingSince >= APPROVAL_STALE_MS };
  if (run.lastEventAt !== null) return now - run.lastEventAt >= RUN_QUIET_MS ? { kind: 'stalled', since: run.lastEventAt } : { kind: 'live' };
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started)) return { kind: 'live' };
  return now - started >= RUN_UNHEARD_MS ? { kind: 'stalled', since: started } : { kind: 'live' };
}

/** A Room run's liveness from its header and card; `status` is the one shown (`effectiveRunStatus`). */
export function cardLiveness(
  meta: Pick<SessionRunMeta, 'startedAt'>,
  card: Pick<SessionCard, 'lastEventAt' | 'permissions'>,
  status: SessionStatus,
  now: number
): RunLiveness | null {
  const pending = card.permissions.pending;
  return runLiveness(
    {
      status,
      startedAt: meta.startedAt,
      lastEventAt: card.lastEventAt,
      pendingSince: pending.length ? Math.min(...pending.map((p) => p.requestedAt)) : null,
    },
    now
  );
}

/** How long, in a word or two: "45m", "6h", "6d". */
export function quietFor(since: number, now: number): string {
  const m = Math.max(1, Math.round((now - since) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
