import { events, rpc } from '@renderer/lib/ipc';
import { rigOrchProgressChannel, type OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * Where the Read step's progress comes from: the real first run, or (dev and
 * tests) a recorded one played back. `start` begins it and returns a stop.
 */
export type ProgressSource = {
  start(onEvent: (event: OrchProgressEvent) => void): () => void;
};

/**
 * The real first run: starts it (`rpc.rig.orch.firstRun`) and passes on its
 * events. Only the first run's own: events of a scheduled run going at the
 * same time are left out. Safe to start twice (a remount): main runs one
 * first run and hands a late caller its events so far, and each event is
 * passed on once, in order (`seq`).
 */
export const liveFirstRun: ProgressSource = {
  start(onEvent) {
    let run: string | null = null;
    let next = 0;
    let stopped = false;
    const deliver = (event: OrchProgressEvent) => {
      if (stopped) return;
      if (event.kind === 'start' && event.trigger === 'first' && run === null) run = event.run;
      if (run === null || event.run !== run) return;
      if (event.seq !== undefined) {
        if (event.seq < next) return;
        next = event.seq + 1;
      }
      onEvent(event);
    };
    // Live events that come before the answer wait for it: the answer may hold earlier ones.
    let held: OrchProgressEvent[] | null = [];
    const off = events.on(rigOrchProgressChannel, (event) =>
      held ? held.push(event) : deliver(event)
    );
    void rpc.rig.orch
      .firstRun()
      .then((r) => {
        // Refused (Rig Alpha off): it ends here, rather than waiting on a run that never starts.
        if (!r.success) {
          held = null;
          if (!stopped) onEvent({ run: run ?? 'first', kind: 'end', ok: false, error: r.error.message, t: 0 });
          return;
        }
        const sofar = 'events' in r.data ? r.data.events : [];
        for (const event of sofar) deliver(event);
        const waiting = held ?? [];
        held = null;
        for (const event of waiting) deliver(event);
      })
      .catch(() => {
        held = null;
        if (!stopped)
          onEvent({
            run: run ?? 'first',
            kind: 'end',
            ok: false,
            error: "Rig couldn't start reading.",
            t: 0,
          });
      });
    return () => {
      stopped = true;
      off();
    };
  },
};

/**
 * The morning catch-up (main's catch-up.ts), for Home's strip: the one going
 * or just ended, from its events so far, then live; and any catch-up that
 * starts while Home is open (the Mac woke). Never starts one itself.
 */
export const liveCatchUp: ProgressSource = {
  start(onEvent) {
    let run: string | null = null;
    let next = 0;
    let stopped = false;
    const deliver = (event: OrchProgressEvent) => {
      if (stopped) return;
      // A new catch-up begins again from its own start.
      if (event.kind === 'start' && event.trigger === 'catch-up' && event.run !== run) {
        run = event.run;
        next = 0;
      }
      if (run === null || event.run !== run) return;
      if (event.seq !== undefined) {
        if (event.seq < next) return;
        next = event.seq + 1;
      }
      onEvent(event);
    };
    let held: OrchProgressEvent[] | null = [];
    const flush = () => {
      const waiting = held ?? [];
      held = null;
      for (const event of waiting) deliver(event);
    };
    const off = events.on(rigOrchProgressChannel, (event) =>
      held ? held.push(event) : deliver(event)
    );
    // Asked after the listener is up; a failure to ask leaves the live events.
    void Promise.resolve()
      .then(() => rpc.rig.orch.catchUp())
      .then((r) => {
        for (const event of r.success && r.data ? r.data.events : []) deliver(event);
        flush();
      })
      .catch(flush);
    return () => {
      stopped = true;
      off();
    };
  },
};

/**
 * A recorded run played back on its own clock (`t`), `speed` times faster.
 * Dev and tests: the Read step without a live orchestrator pass.
 */
export function replaySource(
  recorded: readonly OrchProgressEvent[],
  { speed = 1 }: { speed?: number } = {}
): ProgressSource {
  return {
    start(onEvent) {
      const timers = recorded.map((event) => {
        const t = 'line' in event ? event.line.t : event.t;
        return setTimeout(() => onEvent(event), Math.max(0, t / speed));
      });
      return () => timers.forEach(clearTimeout);
    },
  };
}
