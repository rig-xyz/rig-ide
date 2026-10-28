import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_RUN_VERSION } from '@shared/rig/first-run';
import { ALPHA_OFF, alphaOnly, readsOnItsOwn } from './alpha';

describe('Rig Alpha', () => {
  it('refuses a click on something of its own while it is off, and lets it through when on', async () => {
    let on = false;
    const run = vi.fn(async (input: { ref: string }) => ok(input.ref));
    const gated = alphaOnly(() => on, run);
    expect(await gated({ ref: 'a' })).toEqual({ success: false, error: { message: ALPHA_OFF } });
    expect(run).not.toHaveBeenCalled();
    on = true;
    expect(await gated({ ref: 'a' })).toEqual(ok('a'));
  });

  it('reads on its own only with Alpha on, the first run done, and a read they have had', () => {
    const done = { alphaEnabled: true, firstRunSeen: FIRST_RUN_VERSION };
    expect(readsOnItsOwn({ ...done, alphaEnabled: false }, true)).toBe(false);
    expect(readsOnItsOwn({ ...done, firstRunSeen: 0 }, true)).toBe(false);
    // Not now: the first run is done, but nothing was ever read.
    expect(readsOnItsOwn(done, false)).toBe(false);
    expect(readsOnItsOwn(done, true)).toBe(true);
  });
});
