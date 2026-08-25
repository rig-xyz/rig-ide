import { describe, expect, it, vi } from 'vitest';
import {
  SessionPersistenceQueue,
  type AppendEventsResult,
  type PersistenceEvent,
} from './session-persistence-queue';

function event(seq: number): PersistenceEvent {
  return { seq, turn: { seq } };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('SessionPersistenceQueue', () => {
  it('keeps a failed earlier batch ahead of later batches and recovers in order', async () => {
    const calls: number[][] = [];
    const wait = vi.fn().mockResolvedValue(undefined);
    const appendEvents = vi
      .fn<(events: PersistenceEvent[]) => Promise<AppendEventsResult>>()
      .mockResolvedValueOnce({ ok: false, message: 'offline', retryable: true })
      .mockResolvedValueOnce({ ok: true, at: 100, persistedThroughSeq: 0 })
      .mockResolvedValueOnce({ ok: true, at: 200, persistedThroughSeq: 1 });
    const queue = new SessionPersistenceQueue({
      appendEvents: async (events) => {
        calls.push(events.map((item) => item.seq));
        return appendEvents(events);
      },
      wait,
    });

    queue.enqueue([event(0)]);
    queue.enqueue([event(1)]);
    await flushMicrotasks();
    await expect(queue.flush()).resolves.toBe(true);

    expect(calls).toEqual([[0], [0], [1]]);
    expect(wait).toHaveBeenCalledWith(250);
    expect(queue.status).toBe('idle');
  });

  it('deduplicates persisted, in-flight, and pending sequence numbers', async () => {
    const firstAppend = deferred<AppendEventsResult>();
    const appendEvents = vi
      .fn<(events: PersistenceEvent[]) => Promise<AppendEventsResult>>()
      .mockReturnValueOnce(firstAppend.promise)
      .mockResolvedValueOnce({ ok: true, at: 123, persistedThroughSeq: 2 });
    const queue = new SessionPersistenceQueue({ appendEvents });
    queue.markPersisted([{ seq: 0 }]);

    queue.enqueue([event(0), event(1), event(1)]);
    queue.enqueue([event(1), event(2)]);
    await flushMicrotasks();
    expect(appendEvents).toHaveBeenCalledTimes(1);
    expect(appendEvents).toHaveBeenCalledWith([event(1)]);

    firstAppend.resolve({ ok: true, at: 122, persistedThroughSeq: 1 });
    await flushMicrotasks();
    await expect(queue.flush()).resolves.toBe(true);
    queue.enqueue([event(1), event(2), event(3)]);
    await flushMicrotasks();
    expect(appendEvents).toHaveBeenCalledTimes(3);
    expect(appendEvents).toHaveBeenLastCalledWith([event(3)]);
  });

  it('deduplicates only acknowledged batch members when a batch has a gap', async () => {
    const appendEvents = vi
      .fn<(events: PersistenceEvent[]) => Promise<AppendEventsResult>>()
      .mockResolvedValueOnce({ ok: true, at: 124, persistedThroughSeq: 2 })
      .mockResolvedValueOnce({ ok: true, at: 125, persistedThroughSeq: 2 });
    const queue = new SessionPersistenceQueue({ appendEvents });

    queue.enqueue([event(0), event(2)]);
    await expect(queue.flush()).resolves.toBe(true);
    queue.enqueue([event(1)]);
    await expect(queue.flush()).resolves.toBe(true);

    expect(appendEvents).toHaveBeenNthCalledWith(2, [event(1)]);
  });

  it('exposes degraded status during retry and returns to idle after recovery', async () => {
    const statuses: string[] = [];
    const appendEvents = vi
      .fn<(events: PersistenceEvent[]) => Promise<AppendEventsResult>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, at: 456, persistedThroughSeq: 5 });
    const queue = new SessionPersistenceQueue({
      appendEvents,
      wait: vi.fn().mockResolvedValue(undefined),
      onStatusChange: (status) => statuses.push(status),
    });

    queue.enqueue([event(5)]);
    await flushMicrotasks();

    expect(statuses).toContain('degraded');
    expect(statuses.at(-1)).toBe('idle');
    expect(queue.message).toBe('');
  });

  it('times out bounded flush while retaining work for a later retry', async () => {
    const append = deferred<AppendEventsResult>();
    const appendEvents = vi
      .fn<(events: PersistenceEvent[]) => Promise<AppendEventsResult>>()
      .mockReturnValue(append.promise);
    const queue = new SessionPersistenceQueue({ appendEvents });

    queue.enqueue([event(7)]);
    await flushMicrotasks();
    await expect(queue.flush(1)).resolves.toBe(false);

    append.resolve({ ok: true, at: 789, persistedThroughSeq: 7 });
    await flushMicrotasks();
    expect(queue.status).toBe('idle');
  });

  it('does not notify acknowledgement observers after a timed-out close', async () => {
    const append = deferred<AppendEventsResult>();
    const onAck = vi.fn();
    const queue = new SessionPersistenceQueue({
      appendEvents: vi.fn().mockReturnValue(append.promise),
      onAck,
    });

    queue.enqueue([event(10)]);
    await flushMicrotasks();
    await expect(queue.close(1)).resolves.toBe(false);
    append.resolve({ ok: true, at: 1_000, persistedThroughSeq: 10 });
    await flushMicrotasks();
    expect(onAck).not.toHaveBeenCalled();
  });

  it('flushes before close and ignores new work after close', async () => {
    const appendEvents = vi
      .fn<(events: PersistenceEvent[]) => Promise<AppendEventsResult>>()
      .mockResolvedValue({ ok: true, at: 999, persistedThroughSeq: 8 });
    const queue = new SessionPersistenceQueue({ appendEvents });
    queue.enqueue([event(8)]);

    await expect(queue.close(100)).resolves.toBe(true);
    queue.enqueue([event(9)]);
    await flushMicrotasks();
    expect(appendEvents).toHaveBeenCalledTimes(1);
    expect(queue.status).toBe('idle');
  });
});
