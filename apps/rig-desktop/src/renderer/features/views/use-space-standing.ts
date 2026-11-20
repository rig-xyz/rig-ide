import { useEffect, useRef, useState } from 'react';
import type { SpaceState } from '@shared/rig/space-state';
import type { ViewManifest } from '@shared/rig/views';
import { newlyScheduled } from './space-status';
import { useSpaceState } from './use-space-state';
import { useViewTurnsRunning } from './view-activity';

/** How long a schedule that just appeared keeps saying so. */
const JUST_SCHEDULED_MS = 60_000;

/**
 * What the space's standing work needs to be drawn (spike, Rig Alpha), for the tabs rail and the
 * pill down the Room's right edge: the runtime's state, the views a turn was just started from,
 * the schedules that appeared while the space was open, and a clock that moves every minute.
 */
export function useSpaceStanding(
  bindingId: string,
  views: readonly ViewManifest[]
): {
  spaceState: SpaceState | null;
  /** Views the old renderer store knows a turn is going for. */
  working: readonly string[];
  justScheduled: ReadonlySet<string>;
  now: number;
} {
  const working = useViewTurnsRunning(bindingId);
  // A view or schedule that just appeared is looked at by main at once, not at the next minute.
  const refreshKey = views
    .map((v) => `${v.name}:${v.everyMs}:${v.at ? `${v.at.days ?? ''}@${v.at.minute}${v.at.tz ?? ''}` : ''}:${v.updatedMs}`)
    .join('|');
  const spaceState = useSpaceState(bindingId, refreshKey);
  // Schedules that appeared while the space was open say so for a minute.
  const seenSchedules = useRef<{ bindingId: string; every: Map<string, number | null> } | null>(
    null
  );
  const [justScheduled, setJustScheduled] = useState<ReadonlySet<string>>(() => new Set());
  const clearTimers = useRef(new Set<number>());
  useEffect(() => {
    const prev =
      seenSchedules.current?.bindingId === bindingId ? seenSchedules.current.every : null;
    const arrived = newlyScheduled(prev, views);
    seenSchedules.current = {
      bindingId,
      every: new Map(views.map((view) => [view.name, view.everyMs])),
    };
    if (arrived.length === 0) return;
    setJustScheduled((current) => new Set([...current, ...arrived]));
    const timer = window.setTimeout(() => {
      clearTimers.current.delete(timer);
      setJustScheduled((current) => {
        const next = new Set(current);
        for (const name of arrived) next.delete(name);
        return next;
      });
    }, JUST_SCHEDULED_MS);
    clearTimers.current.add(timer);
  }, [bindingId, views]);
  useEffect(() => {
    const timers = clearTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  // Freshness is relative to now: look again every minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return { spaceState, working, justScheduled, now };
}
