import { useSyncExternalStore } from 'react';

/**
 * Turns that view actions have started and that are still going, per space and per view. The tabs
 * rail reads it to show which view the member's session is working for, and, on the Room's row,
 * that it is working at all (the Room itself is not on screen then).
 */
const running = new Map<string, Map<string, number>>();
/** Per space, the names of the views with a turn going, joined: a stable value for the store's snapshot. */
const snapshots = new Map<string, string>();
const listeners = new Set<() => void>();

function change(bindingId: string, view: string, by: number): void {
  const views = running.get(bindingId) ?? new Map<string, number>();
  const next = (views.get(view) ?? 0) + by;
  if (next > 0) views.set(view, next);
  else views.delete(view);
  if (views.size > 0) running.set(bindingId, views);
  else running.delete(bindingId);
  snapshots.set(bindingId, [...views.keys()].sort().join('\n'));
  for (const listener of listeners) listener();
}

/** Marks one turn started from `view` as running in `bindingId`; call the result when it is over. */
export function viewTurnStarted(bindingId: string, view: string): () => void {
  change(bindingId, view, 1);
  let over = false;
  return () => {
    if (over) return;
    over = true;
    change(bindingId, view, -1);
  };
}

/** The views of this space that have a turn going right now. */
export function useViewTurnsRunning(bindingId: string): readonly string[] {
  const joined = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshots.get(bindingId) ?? ''
  );
  return joined ? joined.split('\n') : [];
}
