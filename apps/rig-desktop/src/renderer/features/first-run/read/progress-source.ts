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
 * events. Only the first-run's own: events of a scheduled run going at the
 * same time are left out.
 */
export const liveFirstRun: ProgressSource = {
  start(onEvent) {
    let run: string | null = null;
    const off = events.on(rigOrchProgressChannel, (event) => {
      if (event.kind === 'start' && event.trigger === 'first') run = event.run;
      if (run !== null && event.run === run) onEvent(event);
    });
    void rpc.rig.orch.firstRun().catch(() => {
      onEvent({
        run: run ?? 'first',
        kind: 'end',
        ok: false,
        error: "Rig couldn't start reading.",
        t: 0,
      });
    });
    return off;
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
