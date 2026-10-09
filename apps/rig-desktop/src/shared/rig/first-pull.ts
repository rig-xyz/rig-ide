/**
 * Has a just-joined space's first download finished, as its sync process
 * says (`tapd status --json`)? The file tree reads this instead of guessing
 * from disk events, which fire for tapd's own state writes too and so ended
 * "syncing" while files were still on their way.
 *
 * Done means tapd reached the relay and had nothing left to apply. Offline
 * is still syncing, with no count. No answer at all (no tapd, not bound) is
 * `unknown`, and the tree falls back to what it saw on disk.
 */

/** The parts of `tapd status --json` this reads. */
export type FirstPullTapdStatus = { pendingApplies?: number; offline?: boolean };

/** tapd's probe of the relay's change log stops at this many. */
export const TAPD_PENDING_PROBE_LIMIT = 100;

export type RigFirstPull =
  | { state: 'syncing'; pending: number | null }
  | { state: 'done' }
  | { state: 'unknown' };

export function firstPullFrom(tapd: FirstPullTapdStatus | null): RigFirstPull {
  if (!tapd) return { state: 'unknown' };
  if (tapd.offline) return { state: 'syncing', pending: null };
  const pending = tapd.pendingApplies ?? 0;
  return pending > 0 ? { state: 'syncing', pending } : { state: 'done' };
}

/** The line under "Still syncing", or null when there's no count to give. */
export function stillSyncingDetail(pull: RigFirstPull | null): string | null {
  if (pull?.state !== 'syncing' || pull.pending === null) return null;
  if (pull.pending >= TAPD_PENDING_PROBE_LIMIT) return `${TAPD_PENDING_PROBE_LIMIT} or more changes to go`;
  return pull.pending === 1 ? '1 change to go' : `${pull.pending} changes to go`;
}
