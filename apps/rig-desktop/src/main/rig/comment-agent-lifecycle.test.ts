import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnDeadline } from './comment-agent-lifecycle';

afterEach(() => vi.useRealTimers());

describe('createTurnDeadline', () => {
  it('measures agent inactivity rather than total turn runtime', async () => {
    vi.useFakeTimers();
    const deadline = createTurnDeadline({ idleTimeoutMs: 100, absoluteTimeoutMs: 1_000 });
    let settled = false;
    void deadline.outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(90);
    deadline.noteActivity();
    await vi.advanceTimersByTimeAsync(90);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(11);
    await expect(deadline.outcome).resolves.toBe('timeout');
  });

  it('pauses idle time for permission while preserving the absolute ceiling', async () => {
    vi.useFakeTimers();
    const onAbsoluteTimeout = vi.fn();
    const deadline = createTurnDeadline({
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 500,
      onAbsoluteTimeout,
    });
    deadline.setAwaitingPermission(true);

    await vi.advanceTimersByTimeAsync(500);

    await expect(deadline.outcome).resolves.toBe('timeout');
    expect(onAbsoluteTimeout).toHaveBeenCalledWith(true);
  });
});
