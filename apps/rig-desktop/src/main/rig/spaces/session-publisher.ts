import { log } from '@main/lib/logger';
import type { RelayApiError, SessionEventInput, SessionStatus, SpacesRelayApi } from './relay-api';

/**
 * Whether a failed `postSessionEvents` call is worth retrying at all.
 * Retryable: 429 (rate limit — the batch is fine, just untimely), any 5xx,
 * and a transport failure (no `status`: `fetch` itself threw, e.g. DNS/
 * timeout/offline — see `relay-api.ts`'s `transportError`). Not retryable:
 * any other 4xx (the batch itself is what the relay is rejecting — retrying
 * unchanged bytes only wastes the retry budget), and the account-level
 * errors (`notSignedIn`/`untrustedRelay`/`invalidToken`) no batch resend
 * fixes.
 */
function isRetryable(error: RelayApiError): boolean {
  if (error.kind !== 'relay') return false;
  if (error.status === undefined) return true;
  return error.status === 429 || error.status >= 500;
}

/** A published session title's cap: the same as the run title `startTurn` creates. */
const TITLE_MAX_CHARS = 80;

/**
 * Any block rig wraps hidden context in (`<rig_space_context>`,
 * `<rig_connectors>`, `<rig_context_target version="1">`, …). An unclosed
 * one, as a truncated echo would leave it, runs to the end of the text.
 */
const RIG_TAGGED_BLOCK = /<(rig_[a-z0-9_]+)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;

/**
 * Matches `hidden` verbatim except for whitespace: Codex collapses runs of
 * whitespace when it turns a prompt into a title, so a plain `includes`
 * would miss the echo.
 */
function hiddenContextPattern(hidden: string): RegExp | null {
  const words = hidden.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
}

/** `text` without the run's hidden context or any `<rig_…>` block (trimmed if anything went), else `text` itself. */
function stripHiddenContext(text: string, hidden: RegExp | null): string {
  const stripped = (hidden ? text.replace(hidden, ' ') : text).replace(RIG_TAGGED_BLOCK, ' ');
  return stripped === text ? text : stripped.trim();
}

/**
 * Removes what an agent echoes back of the prompt's hidden context before an
 * event leaves the machine. The dispatcher sends the member's visible prompt
 * plus a hidden context block (instructions, the room transcript, connector
 * notes, a doc thread); adapters echo the prompt back, and every member of
 * the space can read the uploaded events:
 * - `session_info_update.title`: Codex titles the session with its whole
 *   first prompt, hidden block included, and Claude's generated title is
 *   written from text that is mostly that block. The published title is
 *   always the visible prompt instead.
 * - `user_message_chunk`: a replayed prompt carries the hidden block as its
 *   own text. It's stripped, and an echo with nothing visible left is dropped.
 * Returns null to drop the event. Never mutates `payload` (the same object
 * also feeds the local session).
 */
export function redactPromptEcho(
  kind: string,
  payload: Record<string, unknown>,
  prompt: { visible: string; hidden: RegExp | null }
): Record<string, unknown> | null {
  if (kind === 'session_info_update' && typeof payload.title === 'string') {
    const visible = prompt.visible.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
    return { ...payload, title: visible || null };
  }
  if (kind === 'user_message_chunk') {
    const content = payload.content as { type?: unknown; text?: unknown } | undefined;
    if (content?.type !== 'text' || typeof content.text !== 'string') return payload;
    const text = stripHiddenContext(content.text, prompt.hidden);
    if (!text) return null;
    return text === content.text ? payload : { ...payload, content: { ...content, text } };
  }
  return payload;
}

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
 *
 * A batch that fails RETRYABLY — 429 (the relay's 600 req/min-per-IP limit,
 * honoring `Retry-After` when it sends one), 5xx, or a transport error — is
 * retried with bounded exponential backoff and jitter, up to `maxRetryMs`
 * (default ~60s) of wall time for that one batch before it's finally dropped
 * with a warning; a non-retryable 4xx (a genuinely bad batch) drops right
 * away instead of hammering the relay with something it will never accept.
 * This is what keeps a burst of 429s (a run producing events faster than the
 * relay's per-IP window allows) from silently truncating the run's log —
 * `seq` gaps, a missing answer tail, a missing `turn_ended` — the way it used
 * to before every batch retried unconditionally with no backoff.
 */

export type SessionPublisherOptions = {
  api: SpacesRelayApi;
  bindingId: string;
  runId: string;
  /** The member's visible prompt for this run: what a published session title becomes (see `redactPromptEcho`). */
  prompt?: string;
  /** Flush cadence — defaults match the session-log spike's own 250ms/32. */
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** Oldest-first drop threshold once the retry queue backs up. */
  maxQueueSize?: number;
  /**
   * How long ONE batch may keep retrying a retryable failure before it's
   * dropped, and (reused, since normally at most one batch is still
   * in-flight-or-retrying by the time `finish()` runs) how long `finish()`
   * itself will wait for the tail to drain before giving up — so an
   * unreachable relay can't block app quit forever.
   */
  maxRetryMs?: number;
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Jitter source for backoff delays — injectable for deterministic tests. */
  random?: () => number;
};

export class SessionEventPublisher {
  private readonly api: SpacesRelayApi;
  private readonly bindingId: string;
  private readonly runId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly maxRetryMs: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: (cb: () => void, ms: number) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly prompt: string;
  /** The hidden context the dispatcher sent with this run's prompt, as a whitespace-tolerant pattern; null until `setHiddenContext`. */
  private hiddenContext: RegExp | null = null;

  private queue: SessionEventInput[] = [];
  private nextSeq = 1;
  private timer: unknown = null;
  private timerDeadline: number | null = null;
  /** Retry bookkeeping for the batch currently at the head of the queue; null when it hasn't failed yet. Reset whenever that batch is sent (success or a non-retryable drop) so the NEXT batch starts its own budget fresh. */
  private retryState: { startedAt: number; attempt: number } | null = null;
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
    this.maxRetryMs = options.maxRetryMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancelTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.random = options.random ?? Math.random;
    this.prompt = options.prompt ?? '';
  }

  /**
   * The hidden context block sent alongside this run's prompt, so an agent's
   * echo of it is stripped before publishing (see `redactPromptEcho`). Set
   * before the prompt is queued: nothing the agent echoes can arrive sooner.
   */
  setHiddenContext(hiddenContext: string): void {
    this.hiddenContext = hiddenContextPattern(hiddenContext);
  }

  /** Events queued but not yet successfully sent — for tests and diagnostics. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queues one event with the next sequence number, minus any echo of the
   * prompt's hidden context (`redactPromptEcho`). Synchronous, never
   * throws. Flushes immediately once the queue reaches `maxBatchSize`;
   * otherwise arms (or leaves armed) the flush timer.
   */
  record(kind: string, payload: Record<string, unknown>): void {
    if (this.disposed) return;
    const redacted = redactPromptEcho(kind, payload, { visible: this.prompt, hidden: this.hiddenContext });
    if (!redacted) return;
    if (this.queue.length >= this.maxQueueSize) {
      const dropped = this.queue.shift();
      log.warn('Rig spaces publisher: retry queue full, dropping the oldest event', {
        runId: this.runId,
        droppedKind: dropped?.kind,
        droppedSeq: dropped?.seq,
      });
    }
    this.queue.push({ seq: this.nextSeq, kind, payload: redacted });
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

  /** Resolves after `ms` (via the injected timer, so tests control it like any other delay). */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduleTimeout(() => resolve(), Math.max(0, ms));
    });
  }

  /**
   * The delay before the next retry of the batch at the head of the queue.
   * `Retry-After` (converted to ms by `relay-api.ts`) wins outright when the
   * relay sent one — it knows its own window better than we can guess.
   * Otherwise: exponential backoff off `flushIntervalMs` (so a first retry
   * lands on the same cadence a healthy relay would have gotten anyway),
   * capped at 30s per attempt, with "equal jitter" (half the base, plus up
   * to another half at random) so a fleet of publishers hitting the same
   * per-IP limit doesn't retry in lockstep. Never exceeds what's left of
   * this batch's own `maxRetryMs` budget.
   */
  private nextDelayMs(attempt: number, retryAfterMs: number | undefined, remainingBudgetMs: number): number {
    if (retryAfterMs !== undefined) return Math.max(0, Math.min(retryAfterMs, remainingBudgetMs));
    const base = Math.min(this.flushIntervalMs * 2 ** (attempt - 1), 30_000);
    const jittered = base / 2 + this.random() * (base / 2);
    return Math.max(0, Math.min(jittered, remainingBudgetMs));
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

  /** Drops the batch at the head of the queue (sent or given up on) and, if more is queued, arms an immediate flush for it. */
  private dropHeadBatch(batchLength: number): void {
    this.retryState = null;
    this.queue = this.queue.slice(batchLength);
    if (this.queue.length > 0 && !this.disposed) this.armTimer(0);
  }

  private async sendBatch(): Promise<void> {
    const batch = this.queue.slice(0, this.maxBatchSize);
    const result = await this.api.postSessionEvents(this.bindingId, this.runId, batch);
    if (result.success) {
      this.dropHeadBatch(batch.length);
      return;
    }

    if (!isRetryable(result.error)) {
      log.warn('Rig spaces publisher: batch rejected, dropping (not retryable)', {
        runId: this.runId,
        count: batch.length,
        status: result.error.kind === 'relay' ? result.error.status : undefined,
        error: result.error.message,
      });
      this.dropHeadBatch(batch.length);
      return;
    }

    const state = this.retryState ?? { startedAt: this.now(), attempt: 0 };
    state.attempt += 1;
    const remainingBudgetMs = this.maxRetryMs - (this.now() - state.startedAt);
    if (remainingBudgetMs <= 0) {
      log.warn('Rig spaces publisher: batch still failing after the retry budget, dropping', {
        runId: this.runId,
        count: batch.length,
        attempts: state.attempt,
        error: result.error.message,
      });
      this.dropHeadBatch(batch.length);
      return;
    }
    this.retryState = state;
    const delay = this.nextDelayMs(
      state.attempt,
      result.error.kind === 'relay' ? result.error.retryAfterMs : undefined,
      remainingBudgetMs
    );
    log.warn('Rig spaces publisher: batch failed, will retry', {
      runId: this.runId,
      count: batch.length,
      attempt: state.attempt,
      delayMs: delay,
      error: result.error.message,
    });
    // Leave `this.queue` untouched — retried once the backoff delay elapses.
    if (!this.disposed) this.armTimer(delay);
  }

  /**
   * Flushes everything still queued (retrying past-failures included) and
   * patches the run's terminal status. Best-effort: a failure to flush the
   * tail or patch status is logged, never thrown — the local session has
   * already ended regardless of whether the relay heard about it.
   *
   * Bounded by `maxRetryMs` overall so an unreachable (or persistently
   * rate-limiting) relay can't block app quit forever: past that cap
   * whatever's still queued is dropped, logged, and `finish()` moves on to
   * patch the status anyway.
   */
  async finish(status: SessionStatus): Promise<void> {
    const deadline = this.now() + this.maxRetryMs;
    // Cancel any armed cadence/retry timer — from here on, THIS loop drives
    // every flush attempt directly, so a stale timer can't also fire (or
    // block a fresh `armTimer` call from taking effect: `armTimer` keeps
    // whichever deadline is sooner, which would otherwise pin a retry to a
    // timer that finish() already bypassed).
    this.stopTimer();
    // A timer-driven flush may be mid-send right now: wait for it first, so
    // its outcome counts and our own flush isn't a no-op mistaken for "no
    // progress" (which used to drop the run's tail, `turn_ended` included).
    if (this.flushing) await this.flushing;
    while (this.queue.length > 0) {
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        log.warn('Rig spaces publisher: finish() gave up on the retrying tail after the cap', {
          runId: this.runId,
          pending: this.queue.length,
        });
        break;
      }
      // A batch that already failed once is backing off behind an armed
      // timer: honor that wait (bounded by what's left of our own cap)
      // rather than re-hammering the relay immediately. A batch that hasn't
      // been tried yet (or just succeeded, with more still queued) has no
      // backoff to respect, so `flush()` below runs it right away.
      if (this.timer !== null && this.retryState !== null) {
        const untilTimer = this.timerDeadline !== null ? Math.max(0, this.timerDeadline - this.now()) : 0;
        this.cancelTimeout(this.timer);
        this.timer = null;
        this.timerDeadline = null;
        await this.wait(Math.min(untilTimer, remainingMs));
      }
      await this.flush();
    }
    this.stopTimer();
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
