import { err, ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveMacTracker, type ActiveMacDeps } from './active-mac';

describe('active Mac tracker', () => {
  let idle: number;
  let mostRecent: string | null;
  let activeComputer: ReturnType<typeof vi.fn<ActiveMacDeps['activeComputer']>>;

  beforeEach(() => {
    idle = 0;
    mostRecent = null;
    activeComputer = vi.fn<ActiveMacDeps['activeComputer']>(async (markActive) => {
      if (markActive) mostRecent = markActive;
      return ok({ device: mostRecent });
    });
  });

  const make = () =>
    createActiveMacTracker(
      { device: () => 'mac-a', idleSeconds: () => idle, activeComputer },
      30_000
    );

  it('says it is in use while touched, and only asks while idle', async () => {
    const tracker = make();
    await tracker.tick();
    expect(activeComputer).toHaveBeenLastCalledWith('mac-a');
    idle = 120;
    await tracker.tick();
    expect(activeComputer).toHaveBeenLastCalledWith(undefined);
    // Woken or unlocked: in use, whatever the idle clock says.
    await tracker.tick(true);
    expect(activeComputer).toHaveBeenLastCalledWith('mac-a');
  });

  it('is elsewhere only when another Mac was used last and this one sits idle', async () => {
    const tracker = make();
    expect(tracker.usingAnotherMac()).toBe(false);

    mostRecent = 'mac-b';
    idle = 120;
    await tracker.tick();
    expect(tracker.usingAnotherMac()).toBe(true);

    // Touched again: here, at once, before the relay hears of it.
    idle = 1;
    expect(tracker.usingAnotherMac()).toBe(false);
  });

  it('keeps what it knew when the relay cannot be reached; an older relay never says elsewhere', async () => {
    const tracker = make();
    mostRecent = 'mac-b';
    idle = 120;
    await tracker.tick();
    activeComputer.mockResolvedValueOnce(err({ kind: 'network' }));
    await tracker.tick();
    expect(tracker.usingAnotherMac()).toBe(true);

    activeComputer.mockResolvedValueOnce(ok({ device: null }));
    await tracker.tick();
    expect(tracker.usingAnotherMac()).toBe(false);
  });
});
