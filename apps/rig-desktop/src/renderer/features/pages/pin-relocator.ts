/**
 * When a page's pins are looked for again (`rig.pages.locate`): when the
 * page says it moved (`pagePinsMovedChannel`), at most once per animation
 * frame while those signals keep coming, and once every `SAFETY_TICK_MS`
 * in case one was missed. Nothing runs while the page is still. One look at
 * a time; a signal during a look runs one more after it.
 */

export const SAFETY_TICK_MS = 2_000;

export interface RelocatorDeps {
  locate(): Promise<void>;
  /** Calls back on each "moved" for this page; returns an unsubscribe. */
  subscribe(onMoved: () => void): () => void;
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export interface Relocator {
  /** Look again soon (the panel resized, pins changed). */
  poke(): void;
  stop(): void;
}

export function startRelocator(deps: RelocatorDeps): Relocator {
  const raf = deps.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = deps.caf ?? ((id) => cancelAnimationFrame(id));
  const every = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clear = deps.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  let frame: number | null = null;
  let running = false;
  let again = false;
  let stopped = false;

  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await deps.locate();
    } catch {
      // The next signal or tick tries again.
    } finally {
      running = false;
    }
    if (again && !stopped) {
      again = false;
      schedule();
    }
  };
  const schedule = () => {
    if (stopped || frame !== null) return;
    frame = raf(() => {
      frame = null;
      void run();
    });
  };

  const off = deps.subscribe(schedule);
  const tick = every(schedule, SAFETY_TICK_MS);
  schedule();
  return {
    poke: schedule,
    stop() {
      stopped = true;
      off();
      clear(tick);
      if (frame !== null) caf(frame);
      frame = null;
    },
  };
}
