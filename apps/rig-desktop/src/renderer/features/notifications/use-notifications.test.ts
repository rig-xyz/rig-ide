import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RigNotification } from '@shared/rig/notifications';
import {
  fetchSpaceActivity,
  NOTIFICATION_ACTIVITY_KEY,
  spaceActivityKey,
} from './use-notifications';

const activity = vi.fn();
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { rig: { notifications: { activity: (input: unknown) => activity(input) } } },
  events: { on: () => () => {} },
}));

const row = (id: string, bindingId: string | null): RigNotification => ({
  id,
  type: 'mention',
  tier: 'direct',
  bindingId,
  spaceName: null,
  actor: { kind: 'user', userId: 'maya', name: 'Maya', agent: null },
  messageId: 'm1',
  messageSeq: null,
  runId: null,
  requestId: null,
  inviteId: null,
  path: null,
  title: '',
  body: '',
  createdAt: '2026-10-01T10:00:00Z',
  readAt: null,
});

describe('fetchSpaceActivity', () => {
  beforeEach(() => activity.mockReset());

  it("asks the relay for this Space's rows, up to 100", async () => {
    activity.mockResolvedValueOnce({ success: true, data: [row('1', 'bnd_a')] });
    expect((await fetchSpaceActivity('bnd_a'))!.map((r) => r.id)).toEqual(['1']);
    expect(activity).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledWith({ limit: 100, bindingId: 'bnd_a' });
  });

  it("keeps only this Space's rows when a relay from before the param ignores it", async () => {
    activity.mockResolvedValueOnce({
      success: true,
      data: [row('1', 'bnd_b'), row('2', 'bnd_a'), row('3', null)],
    });
    expect((await fetchSpaceActivity('bnd_a'))!.map((r) => r.id)).toEqual(['2']);
  });

  it('falls back to the cross-Space page, filtered, when the relay rejects the param', async () => {
    activity
      .mockResolvedValueOnce({ success: false, error: { message: 'bad', status: 400 } })
      .mockResolvedValueOnce({ success: true, data: [row('1', 'bnd_b'), row('2', 'bnd_a')] });
    expect((await fetchSpaceActivity('bnd_a'))!.map((r) => r.id)).toEqual(['2']);
    expect(activity).toHaveBeenNthCalledWith(2, { limit: 50 });
  });

  it('falls back too when the call itself throws, and gives null when nothing can be read', async () => {
    activity
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce({ success: true, data: [row('2', 'bnd_a')] });
    expect((await fetchSpaceActivity('bnd_a'))!.map((r) => r.id)).toEqual(['2']);
    activity.mockResolvedValue({ success: false, error: { message: 'offline' } });
    expect(await fetchSpaceActivity('bnd_a')).toBeNull();
  });
});

describe('spaceActivityKey', () => {
  it("sits under the bell's key, so the same invalidation refreshes it, and is its own per Space", () => {
    expect(spaceActivityKey('bnd_a').slice(0, NOTIFICATION_ACTIVITY_KEY.length)).toEqual(
      NOTIFICATION_ACTIVITY_KEY
    );
    expect(spaceActivityKey('bnd_a')).not.toEqual(spaceActivityKey('bnd_b'));
    expect(spaceActivityKey('bnd_a')).not.toEqual(NOTIFICATION_ACTIVITY_KEY);
  });
});
