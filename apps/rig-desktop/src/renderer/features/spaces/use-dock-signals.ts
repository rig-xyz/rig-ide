import { useEffect, useRef, useState } from 'react';
import type { ForYouArrival } from './for-you';
import type { RoomThemes } from './themes';

/**
 * What the dock reacts to as it happens: the listener hearing theme events,
 * a theme just born (its drop, its "new" tag), For you coming into the column
 * (born the same way), and what arrived in For you, which swells the For you
 * pill one arrival at a time.
 *
 * Births and arrivals are worked out while rendering (a render-phase state
 * update, not an effect), so the dock that draws a new theme already knows it
 * is a birth on that very frame: the pill never shows once in its place
 * before it drops in.
 */

/** The dock's clocks, in ms. An object so a test can run them fast. */
export const DOCK_TIMING = {
  /** How long the listener's bead swells after theme events arrive. */
  hearingMs: 1000,
  /** A birth: the bead, then the drop under the rail, then the slide into place, then done. */
  dropAfterMs: 40,
  slideAfterMs: 640,
  settleAfterMs: 1240,
  /** How long a new theme keeps its "new" tag once it is a pill. */
  newTagMs: 4000,
  /** How long the For you pill stays swollen on an arrival. */
  swellMs: 4000,
};

/** The id a For you birth carries in `bornIds`. */
export const FOR_YOU_ID = 'for-you';

export type DockSwell = { key: string; arrival: ForYouArrival };

export type DockSignals = {
  hearing: boolean;
  /** Themes born since the Room opened, for the "new" tag. */
  freshThemeIds: ReadonlySet<string>;
  /** What is being born right now (a theme's id, or `FOR_YOU_ID`): the drop is on its way. */
  bornIds: ReadonlySet<string>;
  /** The arrival the For you pill is swollen with now, if any. */
  swell: DockSwell | null;
};

const NO_IDS: ReadonlySet<string> = new Set();

/** A set of ids that each leave it `ms()` after they joined. */
function useExpiringSet(ms: () => number) {
  const [ids, setIds] = useState<ReadonlySet<string>>(NO_IDS);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const id of ids) {
      if (timers.current.has(id)) continue;
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }, ms())
      );
    }
    // `ms` is read when a timer is set, so a test can change the clocks between births.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
    };
  }, []);
  return [ids, setIds] as const;
}

function withIds(current: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (ids.every((id) => current.has(id))) return current;
  return new Set([...current, ...ids]);
}

export function useDockSignals(
  themes: RoomThemes | null | undefined,
  arrivals: readonly ForYouArrival[],
  /** Whether the For you pill is in the column now. */
  forYouShown: boolean,
  /** Whether For you has had its first look (`ForYouState.ready`): what it holds before is not a birth. */
  forYouReady: boolean
): DockSignals {
  const [hearing, setHearing] = useState(false);
  const [freshThemeIds, setFresh] = useExpiringSet(
    () => DOCK_TIMING.settleAfterMs + DOCK_TIMING.newTagMs
  );
  const [bornIds, setBorn] = useExpiringSet(() => DOCK_TIMING.settleAfterMs);
  const [queue, setQueue] = useState<DockSwell[]>([]);
  const [swell, setSwell] = useState<DockSwell | null>(null);

  // The listener hears the cursor move.
  const cursorRef = useRef<string | null>(null);
  const cursor = themes?.cursor ?? null;
  useEffect(() => {
    const previous = cursorRef.current;
    cursorRef.current = cursor;
    if (previous === null || cursor === null || cursor === previous) return;
    setHearing(true);
    const timer = setTimeout(() => setHearing(false), DOCK_TIMING.hearingMs);
    return () => clearTimeout(timer);
  }, [cursor]);

  // Births: a `born` event applied while the Room is open (`themes.births`). What
  // the Room already holds at the first look is not one, and neither is any theme
  // a re-sync brings in: only the events themselves count.
  const [handled, setHandled] = useState<ReadonlySet<string> | null>(null);
  const has = themes != null;
  const births = themes?.births;
  if (!has) {
    if (handled !== null) setHandled(null);
  } else if (handled === null) {
    setHandled(new Set((births ?? []).map((b) => b.eventId)));
  } else {
    const born = (births ?? []).filter((b) => !handled.has(b.eventId));
    if (born.length > 0) {
      const ids = born.map((b) => b.themeId);
      setHandled(new Set([...handled, ...born.map((b) => b.eventId)]));
      setFresh((current) => withIds(current, ids));
      setBorn((current) => withIds(current, ids));
    }
  }

  // For you coming into the column after its first look is a birth too.
  const [forYouWas, setForYouWas] = useState({ shown: forYouShown, ready: forYouReady });
  if (forYouWas.shown !== forYouShown || forYouWas.ready !== forYouReady) {
    setForYouWas({ shown: forYouShown, ready: forYouReady });
    if (!forYouWas.shown && forYouShown && forYouWas.ready && forYouReady) {
      setBorn((current) => withIds(current, [FOR_YOU_ID]));
    }
  }

  // Arrivals. What was in `arrivals` when the dock mounted is not new.
  const [seenArrivals, setSeenArrivals] = useState(arrivals);
  if (seenArrivals !== arrivals) {
    setSeenArrivals(arrivals);
    if (arrivals.length > 0) {
      setQueue((current) => [
        ...current,
        ...arrivals.map((arrival) => ({ key: `arrival:${arrival.key}`, arrival })),
      ]);
    }
  }

  // One at a time: the next waits for the one showing to fold back, and for
  // For you to finish being born. An arrival that finds For you gone (handled
  // already) has nothing to swell.
  if (swell === null && queue.length > 0 && !bornIds.has(FOR_YOU_ID)) {
    const [next, ...rest] = queue;
    setQueue(rest);
    if (forYouShown) setSwell(next!);
  }
  const swellKey = swell?.key ?? null;
  useEffect(() => {
    if (swellKey === null) return;
    const timer = setTimeout(() => setSwell(null), DOCK_TIMING.swellMs);
    return () => clearTimeout(timer);
  }, [swellKey]);

  return { hearing, freshThemeIds, bornIds, swell };
}
