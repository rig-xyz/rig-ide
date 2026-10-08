import { useSyncExternalStore } from 'react';
import { readAllSpaceMarkers, type SpaceReadMarker } from './room-read-marker';

/**
 * Whether you've seen a finished agent run, for the dock: a finished task
 * row stays until you have, not for a set time.
 *
 * Seen means its card has been on screen in the open space since it ended
 * (`room-transcript.tsx` marks it, and a card on screen as it ends counts
 * at once), or you clicked its row in the dock. That lives in memory for
 * this session. A run that ended before this launch also counts as seen
 * when the space's read markers, as they were at launch, say you were in
 * the space after it ended with its card read past: no relay state is
 * added for this.
 */

const seen = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

export function markRunSeen(runId: string): void {
  if (seen.has(runId)) return;
  seen.add(runId);
  version += 1;
  for (const listener of listeners) listener();
}

export function isRunSeen(runId: string): boolean {
  return seen.has(runId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render when a run is marked seen. */
export function useRunSeenVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** The read markers as they stood when this module loaded, at launch. */
let atLaunch: Map<string, SpaceReadMarker> = readAllSpaceMarkers();

export type FinishedRun = { runId: string; seq: number; endedAt: number };

/** Seen before this launch: you had the space open after the run ended, and had read past its card. */
export function seenBeforeLaunch(markers: SpaceReadMarker | undefined, run: FinishedRun): boolean {
  if (!markers || markers.lastSeenSeq === null || markers.openedAt === null) return false;
  return markers.lastSeenSeq >= run.seq && markers.openedAt >= run.endedAt;
}

/** Whether a finished run's dock row can go: seen this session, or before this launch. */
export function finishedRunSeen(bindingId: string | undefined, run: FinishedRun): boolean {
  return seen.has(run.runId) || (bindingId !== undefined && seenBeforeLaunch(atLaunch.get(bindingId), run));
}

/** Test-only: forget what was seen, and take the markers as they are now as the launch's. */
export function resetRunSeenForTests(): void {
  seen.clear();
  atLaunch = readAllSpaceMarkers();
  version += 1;
}
