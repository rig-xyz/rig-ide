import type { RigAppendEventsResult } from '@shared/rig/sessions';

export type PersistenceEvent = {
  seq: number;
  turn: unknown;
};

/** The main-process append acknowledgement. Only `ok: true` persists a batch. */
export type AppendEventsResult = RigAppendEventsResult;

export type PersistenceQueueStatus = 'idle' | 'saving' | 'degraded';

export const persistenceStatusMessage: Record<PersistenceQueueStatus, string> = {
  idle: '',
  saving: 'Saving…',
  degraded: 'History isn’t being saved yet — retrying…',
};

export type SessionPersistenceQueueOptions = {
  appendEvents: (events: PersistenceEvent[]) => Promise<AppendEventsResult>;
  onAck?: (
    events: readonly PersistenceEvent[],
    at: number,
    persistedThroughSeq: number | null
  ) => void;
  onStatusChange?: (status: PersistenceQueueStatus) => void;
  wait?: (delayMs: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

/**
 * Ordered, single-flight persistence for committed transcript turns.
 *
 * A sequence enters the persisted set only after the main process explicitly
 * acknowledges `{ ok: true }`. Pending and in-flight sequence numbers are
 * deduplicated, while failed batches remain ahead of all later work.
 */
export class SessionPersistenceQueue {
  private readonly pending = new Map<number, PersistenceEvent>();
  private readonly persisted = new Set<number>();
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly waiters = new Set<(flushed: boolean) => void>();
  private inFlight: PersistenceEvent[] | null = null;
  private pumping = false;
  private closed = false;
  private closing = false;
  private closePromise: Promise<boolean> | null = null;
  private _status: PersistenceQueueStatus = 'idle';

  constructor(private readonly options: SessionPersistenceQueueOptions) {
    this.wait = options.wait ?? defaultWait;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 8_000;
  }

  get status(): PersistenceQueueStatus {
    return this._status;
  }

  get message(): string {
    return persistenceStatusMessage[this._status];
  }

  subscribe(listener: (status: PersistenceQueueStatus) => void): () => void {
    const unsubscribe = () => this.listeners.delete(listener);
    this.listeners.add(listener);
    return unsubscribe;
  }

  private readonly listeners = new Set<(status: PersistenceQueueStatus) => void>();

  markPersisted(events: readonly Pick<PersistenceEvent, 'seq'>[]): void {
    for (const event of events) this.persisted.add(event.seq);
  }

  enqueue(events: readonly PersistenceEvent[]): PersistenceEvent[] {
    if (this.closed || this.closing) return [];
    const inFlightSeqs = new Set(this.inFlight?.map((event) => event.seq) ?? []);
    const accepted: PersistenceEvent[] = [];
    for (const event of events) {
      if (this.persisted.has(event.seq) || inFlightSeqs.has(event.seq)) continue;
      if (!this.pending.has(event.seq)) {
        this.pending.set(event.seq, event);
        accepted.push(event);
      }
    }
    if (this.pending.size > 0) {
      this.setStatus('saving');
      void this.pump();
    }
    return accepted;
  }

  /** Waits for all currently queued work, without closing the queue. */
  flush(timeoutMs = 1_000): Promise<boolean> {
    return this.waitForIdle(timeoutMs);
  }

  /**
   * Stops future retries after a bounded flush. An in-flight RPC cannot be
   * cancelled by this protocol; its eventual result is ignored after close.
   */
  async close(timeoutMs = 1_000): Promise<boolean> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.waitForIdle(timeoutMs).then((flushed) => {
      this.closed = true;
      this.setStatus('idle');
      for (const resolve of this.waiters) resolve(flushed);
      this.waiters.clear();
      return flushed;
    });
    return this.closePromise;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.pending.size > 0) {
        const batch = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
        this.pending.clear();
        this.inFlight = batch;
        let attempt = 0;
        while (!this.closed) {
          this.setStatus(attempt === 0 ? 'saving' : 'degraded');
          try {
            const result = await this.options.appendEvents(batch);
            if (this.closed) {
              this.inFlight = null;
              this.resolveWaitersIfIdle();
              break;
            }
            if (result.ok) {
              // The acknowledgement watermark belongs to the store's
              // ordered ACP sequence invariant. The queue itself records
              // only the actual batch members, so a malformed/gapped batch
              // cannot make an unrelated sequence look persisted.
              for (const event of batch) this.persisted.add(event.seq);
              try {
                this.options.onAck?.(batch, result.at, result.persistedThroughSeq);
              } catch {
                // An acknowledgement observer cannot turn a durable write
                // into a retry or duplicate it.
              }
              this.inFlight = null;
              this.setStatus(this.pending.size > 0 ? 'saving' : 'idle');
              this.resolveWaitersIfIdle();
              break;
            }
          } catch {
            // The failed batch remains in `batch` and is retried below.
          }
          if (this.closed) break;
          this.setStatus('degraded');
          const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
          attempt += 1;
          await this.wait(delay);
        }
        if (this.closed) {
          this.inFlight = null;
          this.resolveWaitersIfIdle();
        }
      }
    } finally {
      this.pumping = false;
      this.resolveWaitersIfIdle();
    }
  }

  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.isIdle()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (flushed: boolean) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(finish);
        clearTimeout(timeout);
        resolve(flushed);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(finish);
    });
  }

  private isIdle(): boolean {
    return this.pending.size === 0 && this.inFlight === null;
  }

  private resolveWaitersIfIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of [...this.waiters]) resolve(true);
  }

  private setStatus(status: PersistenceQueueStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const listener of this.listeners) listener(status);
    this.options.onStatusChange?.(status);
  }
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
