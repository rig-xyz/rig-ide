import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSpaceStateChannel, type SpaceRun, type SpaceState } from '@shared/rig/space-state';

/**
 * What each space is doing as a factory, for Home's list of spaces (spike, Rig Alpha): whether a
 * pass is going there now, and when its standing work runs next. From the same runtime state the
 * space's own rail and pill read, for every space this Mac has looked at.
 */
export type SpaceFactory = {
  /** The pass going now (one that waits on the person first), if any. */
  run: SpaceRun | null;
  /** How many of its views run on a schedule in this Rig app. */
  scheduled: number;
  /** When the next of them is due; null with none. */
  nextDueAt: number | null;
};

export function factoryOf(state: SpaceState): SpaceFactory {
  const active = state.runs.filter((run) => run.state === 'working' || run.state === 'waiting');
  const run =
    active.sort(
      (a, b) =>
        Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.startedAt - a.startedAt
    )[0] ?? null;
  const mine = state.views.filter((view) => view.everyMs !== null && view.runsHere !== false);
  const due = mine.flatMap((view) => (view.nextDueAt !== null ? [view.nextDueAt] : []));
  return { run, scheduled: mine.length, nextDueAt: due.length ? Math.min(...due) : null };
}

const REFRESH_MS = 60_000;

export function useFactoryOverview(enabled: boolean): ReadonlyMap<string, SpaceFactory> {
  const [byBinding, setByBinding] = useState<ReadonlyMap<string, SpaceFactory>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => {
      // An app without the route (an older main, a test's stand-in) just shows no factories.
      const all = rpc.rig.spaceState?.all;
      if (typeof all !== 'function') return;
      void Promise.resolve()
        .then(() => all())
        .then((states) => {
          if (live) setByBinding(new Map(states.map((state) => [state.bindingId, factoryOf(state)])));
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    // A turn starting or ending anywhere shows at once.
    const off = events.on(rigSpaceStateChannel, (state) => {
      if (live) setByBinding((current) => new Map(current).set(state.bindingId, factoryOf(state)));
    });
    return () => {
      live = false;
      window.clearInterval(timer);
      off();
    };
  }, [enabled]);
  return byBinding;
}
