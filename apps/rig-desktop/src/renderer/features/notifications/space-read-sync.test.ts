import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const markSpaceRead = vi.fn(async () => ({ success: true, data: undefined }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { rig: { notifications: { markSpaceRead } } } }));

const { readRetryDelayMs, reportSpaceRead } = await import('./space-read-sync');

describe('reportSpaceRead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    markSpaceRead.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('debounces a stream of reads into one request with the highest seq', () => {
    reportSpaceRead('bnd_a', { seq: 3 });
    reportSpaceRead('bnd_a', { seq: 7, seen: true });
    reportSpaceRead('bnd_a', { seq: 5 });
    expect(markSpaceRead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(markSpaceRead).toHaveBeenCalledTimes(1);
    expect(markSpaceRead).toHaveBeenCalledWith({ bindingId: 'bnd_a', seq: 7, seen: true });
  });

  it('keeps spaces apart, and sends at once when asked', () => {
    reportSpaceRead('bnd_a', { seq: 1 });
    reportSpaceRead('bnd_b', { seen: true }, true);
    expect(markSpaceRead).toHaveBeenCalledWith({ bindingId: 'bnd_b', seen: true });
    vi.advanceTimersByTime(2_000);
    expect(markSpaceRead).toHaveBeenLastCalledWith({ bindingId: 'bnd_a', seq: 1 });
    expect(markSpaceRead).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty binding id', () => {
    reportSpaceRead('', { seq: 1 }, true);
    expect(markSpaceRead).not.toHaveBeenCalled();
  });

  it('retries a cursor the relay did not take, with backoff, and drops seen on retry', async () => {
    markSpaceRead.mockResolvedValueOnce({ success: false, error: { message: 'relay down' } } as never);
    reportSpaceRead('bnd_c', { seq: 9, seen: true }, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(markSpaceRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(readRetryDelayMs(1) - 1);
    expect(markSpaceRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(markSpaceRead).toHaveBeenCalledTimes(2);
    expect(markSpaceRead).toHaveBeenLastCalledWith({ bindingId: 'bnd_c', seq: 9 });
  });

  it('retries a request that threw, merged with a newer cursor', async () => {
    markSpaceRead.mockRejectedValueOnce(new Error('ipc closed'));
    reportSpaceRead('bnd_d', { seq: 3 }, true);
    await vi.advanceTimersByTimeAsync(0);
    reportSpaceRead('bnd_d', { seq: 5 });
    await vi.advanceTimersByTimeAsync(readRetryDelayMs(1));
    expect(markSpaceRead).toHaveBeenLastCalledWith({ bindingId: 'bnd_d', seq: 5 });
  });

  it('keeps retrying through an outage, and drops a cursor the relay refuses', async () => {
    markSpaceRead.mockResolvedValue({ success: false, error: { message: 'unreachable' } } as never);
    reportSpaceRead('bnd_e', { seq: 1 }, true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(markSpaceRead.mock.calls.length).toBeGreaterThan(10);
    markSpaceRead.mockReset().mockResolvedValue({ success: false, error: { message: 'seq_out_of_range', status: 400 } } as never);
    reportSpaceRead('bnd_f', { seq: 999 }, true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const forF = (markSpaceRead.mock.calls as unknown as Array<[{ bindingId: string }]>).filter(
      ([input]) => input.bindingId === 'bnd_f'
    );
    expect(forF).toHaveLength(1);
    markSpaceRead.mockReset().mockResolvedValue({ success: true, data: undefined });
  });
});
