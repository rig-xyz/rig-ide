import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const markSpaceRead = vi.fn(async () => ({ success: true, data: undefined }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { rig: { notifications: { markSpaceRead } } } }));

const { reportSpaceRead } = await import('./space-read-sync');

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
});
