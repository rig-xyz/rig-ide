import { log } from '@main/lib/logger';
import type { SessionEventInput, SessionStatus, SpacesRelayApi } from './relay-api';

/**
 * Spaces (lane 3): turns one running ACP agent session's events into
 * batched `POST .../sessions/:runId/events` calls, per the cadence
 * `SPACES_NOTES.md` credits to the session-log spike: flush every 250ms or
 * every 32 events, whichever comes first, with a monotonically increasing
 * `seq` this publisher assigns itself (the relay stores whatever it's
 * given; ordering is the publisher's job, not the wire's).
 *
 * `.record()` NEVER throws and never awaits — it only pushes onto an
 * in-memory queue and (maybe) arms a timer. The point is that a slow or
 * unreachable relay must never slow down or block the local agent session:
 * publishing is fire-and-forget from the caller's perspective. A batch that
 * fails to send is NOT dropped — it stays at the front of the queue and is
 * retried on the next flush (timer-driven or forced by the next `.record()`
 * crossing the size threshold), so events publish in order and nothing is
 * silently lost to one transient relay hiccup. The queue is bounded
 * (`maxQueueSize`) so a relay that is down for a long time can't grow this
 * unboundedly in memory; past the cap, the OLDEST unsent events are dropped
 * (and logged) to make room for new ones — a live session card falling a
 * little out of date beats an ever-growing queue.
 */

export type SessionPublisherOptions = {
  api: SpacesRelayApi;
  bindingId: string;
  runId: string;
  /** Flush cadence — defaults match the session-log spike's own 250ms/32. */
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** Oldest-first drop threshold once the retry queue backs up. */
  maxQueueSize?: number;
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export class SessionEventPublisher {
  private readonly api: SpacesRelayApi;
  private readonly bindingId: string;
  private readonly runId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: (cb: () => void, ms: number) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;

  private queue: SessionEventInput[] = [];
  private nextSeq = 1;
  private timer: unknown = null;
  private timerDeadline: number | null = null;
  /** The flush currently talking to the relay, if any: guards against two overlapping sends, and lets `finish()` wait it out. */
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(options: SessionPublisherOptions) {
    this.api = options.api;
    this.bindingId = options.bindingId;
    this.runId = options.runId;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maxBatchSize = options.maxBatchSize ?? 32;
    this.maxQueueSize = options.maxQueueSize ?? 2000;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancelTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Events queued but not yet successfully sent — for tests and diagnostics. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queues one event with the next sequence number. Synchronous, never
   * throws. Flushes immediately once the queue reaches `maxBatchSize`;
   * otherwise arms (or leaves armed) the flush timer.
   */
  record(kind: string, payload: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      log.warn('Rig spaces publisher: retry queue full, dropping the oldest event', {
        runId: this.runId,
        droppedKind: dropped?.kind,
        droppedSeq: dropped?.seq,
      });
    }
    this.queue.push({ seq: this.nextSeq, kind, payload });
    this.nextSeq += 1;

    if (this.queue.length >= this.maxBatchSize) {
      this.armTimer(0);
    } else {
      this.armTimer(this.flushIntervalMs);
    }
  }

  /**
   * Arms a flush for `delayMs` from now, UNLESS a timer is already armed
   * with an equal-or-earlier deadline (e.g. the 250ms cadence timer from an
   * earlier `.record()` already fires soon enough). A later `.record()`
   * that crosses `maxBatchSize` requests `delayMs=0` and must be able to
   * pre-empt an already-armed 250ms timer — otherwise a full batch would
   * sit waiting for a timer that was armed before it became full.
   */
  private armTimer(delayMs: number): void {
    const deadline = this.now() + delayMs;
    if (this.timer !== null) {
      if (this.timerDeadline !== null && this.timerDeadline <= deadline) return;
      this.cancelTimeout(this.timer);
      this.timer = null;
    }
    this.timerDeadline = deadline;
    this.timer = this.scheduleTimeout(() => {
      this.timer = null;
      this.timerDeadline = null;
      void this.flush();
    }, delayMs);
  }

  /**
   * Sends the current queue's first `maxBatchSize` events. Safe to call
   * directly (e.g. from `finish()`); re-entrant-safe via `flushing`. On
   * failure, the batch stays queued (nothing is removed) and a warning is
   * logged — the next timer tick or `.record()` call retries it.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = this.sendBatch().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async sendBatch(): Promise<void> {
    const batch = this.queue.slice(0, this.maxBatchSize);
    const result = await this.api.postSessionEvents(this.bindingId, this.runId, batch);
    if (!result.success) {
      log.warn('Rig spaces publisher: batch failed, will retry', {
        runId: this.runId,
        count: batch.length,
        error: result.error.message,
      });
      // Leave `this.queue` untouched — retried on the next flush.
      if (!this.disposed) this.armTimer(this.flushIntervalMs);
      return;
    }
    this.queue = this.queue.slice(batch.length);
    if (this.queue.length > 0 && !this.disposed) this.armTimer(0);
  }

  /**
   * Flushes everything still queued (retrying past-failures included) and
   * patches the run's terminal status. Best-effort: a failure to flush the
   * tail or patch status is logged, never thrown — the local session has
   * already ended regardless of whether the relay heard about it.
   */
  async finish(status: SessionStatus): Promise<void> {
    this.stopTimer();
    // Drain the queue one `maxBatchSize` chunk at a time, not an infinite
    // retry loop — `finish()` must return in bounded time even if the relay
    // is down. Stops as soon as a flush makes no progress (the relay is
    // unreachable) rather than spinning five times against a dead host.
    //
    // A timer-driven flush may be mid-send right now: wait for it first, so
    // its outcome counts and our own flush isn't a no-op mistaken for "no
    // progress" (which used to drop the run's tail, `turn_ended` included).
    if (this.flushing) await this.flushing;
    for (let attempts = 0; this.queue.length > 0 && attempts < 5; attempts += 1) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length === before) break; // no progress — relay unreachable, stop spinning
    }
    const patched = await this.api.patchSession(this.bindingId, this.runId, { status });
    if (!patched.success) {
      log.warn('Rig spaces publisher: could not patch final run status', {
        runId: this.runId,
        status,
        error: patched.error.message,
      });
    }
    this.disposed = true;
    this.stopTimer();
  }

  /** Stops the timer without flushing or patching status — for abrupt teardown (app quit). */
  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.cancelTimeout(this.timer);
    this.timer = null;
    this.timerDeadline = null;
  }
}
