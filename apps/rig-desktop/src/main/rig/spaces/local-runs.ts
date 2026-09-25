import type { LocalRunEvent } from '@shared/spaces/room-sees';

/**
 * The owner overlay's store: every event of the runs this computer ran, as
 * the publisher recorded them before the Room-sees filter (after the
 * prompt-echo redaction). The Room reads your own runs from here instead of
 * the relay's filtered copy, so you always see all of your agent's work and
 * answer its approvals with the real command in front of you.
 *
 * In memory and bounded: the most recent `maxRuns` runs, each up to
 * `maxBytesPerRun`. A run past its budget is dropped from here (the Room
 * falls back to the relay's copy of it), as is everything after an app
 * restart.
 */
export class LocalRunStore {
  private readonly runs = new Map<string, { bindingId: string; events: LocalRunEvent[]; bytes: number }>();
  /** Runs that outgrew their budget: never recorded again, so the Room doesn't flip back to a partial copy. */
  private readonly overflowed = new Set<string>();
  private readonly listeners = new Set<(bindingId: string, runId: string, event: LocalRunEvent) => void>();
  private readonly maxRuns: number;
  private readonly maxBytesPerRun: number;

  constructor(options: { maxRuns?: number; maxBytesPerRun?: number } = {}) {
    this.maxRuns = options.maxRuns ?? 100;
    this.maxBytesPerRun = options.maxBytesPerRun ?? 8 * 1024 * 1024;
  }

  append(bindingId: string, runId: string, event: LocalRunEvent): void {
    if (this.overflowed.has(runId)) return;
    let run = this.runs.get(runId);
    if (!run) {
      run = { bindingId, events: [], bytes: 0 };
      this.runs.set(runId, run);
      while (this.runs.size > this.maxRuns) {
        const oldest = this.runs.keys().next().value;
        if (oldest === undefined) break;
        this.runs.delete(oldest);
      }
    }
    run.bytes += JSON.stringify(event.payload ?? null).length;
    if (run.bytes > this.maxBytesPerRun) {
      this.runs.delete(runId);
      this.overflowed.add(runId);
      return;
    }
    run.events.push(event);
    for (const listener of this.listeners) listener(bindingId, runId, event);
  }

  /** Adds one more event after a run's last (e.g. `details_hidden` once the owner hid it). No-op for a run not held here. */
  note(runId: string, kind: string, payload: Record<string, unknown>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const seq = (run.events.at(-1)?.seq ?? 0) + 1;
    this.append(run.bindingId, runId, { seq, kind, payload });
  }

  /** A run's full local copy, or null when this computer doesn't hold one. */
  events(runId: string): LocalRunEvent[] | null {
    return this.runs.get(runId)?.events.slice() ?? null;
  }

  subscribe(listener: (bindingId: string, runId: string, event: LocalRunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
