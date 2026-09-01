import { describe, expect, it, vi } from 'vitest';
import { disposeReplicaSafely } from './intent-bridge-lifecycle';

describe('disposeReplicaSafely', () => {
  it('settles when a session topic has already disappeared', async () => {
    const dispose = vi.fn().mockRejectedValue(new Error('UNKNOWN_TOPIC'));

    await expect(disposeReplicaSafely({ dispose })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
