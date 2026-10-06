import { err, ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveMacTracker, type ActiveMacDeps } from './active-mac';

describe('active Mac tracker', () => {
  let inFront: boolean;
  let mostRecent: string | null;
  let computers: number;
  let activeComputer: ReturnType<typeof vi.fn<ActiveMacDeps['activeComputer']>>;

  beforeEach(() => {
    inFront = true;
    mostRecent = null;
    computers = 2;
    activeComputer = vi.fn<ActiveMacDeps['activeComputer']>(async (markActive) => {
      if (markActive) mostRecent = markActive;
      return ok({ device: mostRecent, computers });
    });
  });

  const make = () =>
    createActiveMacTracker({ device: () => 'mac-a', rigInFront: () => inFront, activeComputer });

  it('with one computer it only ever asks, never says when Rig is in use', async () => {
    computers = 1;
    const tracker = make();
    await tracker.tick();
    await tracker.tick();
    expect(activeComputer.mock.calls).toEqual([[undefined], [undefined]]);
  });

  it('with several, says so while Rig is in front, and only asks otherwise', async () => {
    const tracker = make();
    await tracker.tick();
    // First contact learns there are two Macs and marks this one at once.
    expect(activeComputer.mock.calls).toEqual([[undefined], ['mac-a']]);
    await tracker.tick();
    expect(activeComputer).toHaveBeenLastCalledWith('mac-a');
    inFront = false;
    await tracker.tick();
    expect(activeComputer).toHaveBeenLastCalledWith(undefined);
  });

  it('is elsewhere only when Rig was last used on another Mac and is not in front here', async () => {
    const tracker = make();
    expect(tracker.usingAnotherMac()).toBe(false);
    inFront = false;
    mostRecent = 'mac-b';
    await tracker.tick();
    expect(tracker.usingAnotherMac()).toBe(true);
    // Brought forward: here, at once, before the relay hears of it.
    inFront = true;
    expect(tracker.usingAnotherMac()).toBe(false);
  });

  it('keeps what it knew when the relay cannot be reached; an older relay never says elsewhere', async () => {
    const tracker = make();
    inFront = false;
    mostRecent = 'mac-b';
    await tracker.tick();
    activeComputer.mockResolvedValueOnce(err({ kind: 'network' }));
    await tracker.tick();
    expect(tracker.usingAnotherMac()).toBe(true);
    activeComputer.mockResolvedValueOnce(ok({ device: null, computers: 0 }));
    await tracker.tick();
    expect(tracker.usingAnotherMac()).toBe(false);
  });
});
