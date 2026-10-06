import type { SyncHealth } from '@shared/rig/sync-health';
import type { SyncProblemReason } from '@shared/telemetry';

/**
 * Which sync problems a space has right now, from what the app already
 * knows (`readShownSyncHealth`) and what its sync process says (`tapd status
 * --json`). Pure: the watcher that reads both and sends `sync_problem` is in
 * `sync-problems-instance.ts`. Nothing here keeps a name, id or path.
 */

/** The parts of `tapd status --json` (protocol 1) this reads. */
export type TapdStatus = {
  version?: string;
  daemon?: { running?: boolean };
  pendingApplies?: number;
  pendingUploads?: number;
  conflicts?: ReadonlyArray<unknown>;
  lastApplyError?: { op?: string; reason?: string; at?: string } | null;
  offline?: boolean;
};

export type SyncProblem = { reason: SyncProblemReason; apply_error_kind?: string };

/** How long the relay must stay out of reach before it counts as a problem. */
export const OFFLINE_LONG_MS = 30 * 60_000;
/** An apply error older than this is history, not a problem now. */
export const APPLY_ERROR_FRESH_MS = 24 * 60 * 60_000;

/** Pause reasons that someone chose: deleting or leaving the space. Signing out is only expected while signed out. */
const CHOSEN_PAUSE_REASONS = new Set(['deleted']);

/**
 * A short code for an apply error: the errno (`ENOENT` → `enoent`), an HTTP
 * status (`http_404`), a hash mismatch, else `other`. Never any of the
 * message's own words, which can name files.
 */
export function applyErrorKind(reason: string | undefined): string {
  if (!reason) return 'other';
  const errno = /\bE[A-Z]{2,12}\b/.exec(reason);
  if (errno) return errno[0].toLowerCase();
  if (/hash|checksum|sha256/i.test(reason)) return 'hash_mismatch';
  const status = /\b([45]\d\d)\b/.exec(reason);
  if (status) return `http_${status[1]}`;
  if (/timed? ?out|timeout/i.test(reason)) return 'timeout';
  if (/quota|too large/i.test(reason)) return 'too_large';
  return 'other';
}

export function syncProblemsFrom(input: {
  health: SyncHealth;
  /** Null when the sync process wasn't asked (not running) or couldn't answer. */
  tapd: TapdStatus | null;
  /** When this space was first seen offline in a row of checks, or null. */
  offlineSince: number | null;
  now: number;
}): SyncProblem[] {
  const { health, tapd, offlineSince, now } = input;
  const problems: SyncProblem[] = [];
  switch (health.state) {
    case 'stopped':
      problems.push({ reason: 'daemon_stalled' });
      break;
    case 'error':
      problems.push({ reason: 'other' });
      break;
    case 'paused':
      // Paused by hand (no reason) or because the space is gone is someone's choice.
      if (health.reason && !CHOSEN_PAUSE_REASONS.has(health.reason))
        problems.push({ reason: 'paused_unexpectedly' });
      break;
    default:
      break;
  }
  if (!tapd) return problems;

  const pending = (tapd.pendingApplies ?? 0) + (tapd.pendingUploads ?? 0);
  if (
    tapd.daemon?.running === false &&
    pending > 0 &&
    !problems.some((p) => p.reason === 'daemon_stalled')
  ) {
    problems.push({ reason: 'daemon_stalled' });
  }
  const applyError = tapd.lastApplyError;
  if (applyError) {
    const at = applyError.at ? Date.parse(applyError.at) : Number.NaN;
    if (Number.isNaN(at) || now - at <= APPLY_ERROR_FRESH_MS) {
      problems.push({ reason: 'apply_error', apply_error_kind: applyErrorKind(applyError.reason) });
    }
  }
  if ((tapd.conflicts?.length ?? 0) > 0) problems.push({ reason: 'conflicts' });
  if (tapd.offline && offlineSince !== null && now - offlineSince >= OFFLINE_LONG_MS) {
    problems.push({ reason: 'offline_long' });
  }
  return problems;
}
