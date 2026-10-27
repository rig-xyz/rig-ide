import { err, ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A card's Start that went tells Home the Feed changed, as a Send does: what's working shows at once. */

const emitted = vi.hoisted(() => [] as { channel: unknown; payload: unknown }[]);
const start = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/events', () => ({ events: { emit: (channel: unknown, payload: unknown) => emitted.push({ channel, payload }) } }));
vi.mock('../orch/instance', () => ({ orchActions: { start, act: vi.fn() }, sender: { send: vi.fn() } }));
vi.mock('./relay', () => ({ getFeed: vi.fn(), getSituation: vi.fn() }));

import { rigFeedChangedChannel } from '@shared/rig/feed';
import { rigFeedController } from './controller';

beforeEach(() => {
  emitted.length = 0;
  start.mockReset();
});

describe('rpc.rig.feed.start', () => {
  it('tells Home the Feed changed when the start went', async () => {
    start.mockResolvedValue(ok({ runId: 's1', space: { ref: 'space_b1', name: 'home', root: '/Rig/home' }, brief: '', briefPath: '', continued: false }));
    const r = await rigFeedController.start({ situationId: 'sit_1', task: 'Draft the fix' });
    expect(r.success).toBe(true);
    expect(emitted).toEqual([{ channel: rigFeedChangedChannel, payload: { reason: 'local' } }]);
  });

  it('says nothing when it did not', async () => {
    start.mockResolvedValue(err({ message: 'No space' }));
    await rigFeedController.start({ situationId: 'sit_1' });
    expect(emitted).toEqual([]);
  });
});
