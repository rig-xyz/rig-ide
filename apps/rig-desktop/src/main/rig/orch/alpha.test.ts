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

  it('reads on its own only with Alpha on and the first run done', () => {
    expect(readsOnItsOwn({ alphaEnabled: false, firstRunSeen: FIRST_RUN_VERSION })).toBe(false);
    expect(readsOnItsOwn({ alphaEnabled: true, firstRunSeen: 0 })).toBe(false);
    expect(readsOnItsOwn({ alphaEnabled: true, firstRunSeen: FIRST_RUN_VERSION })).toBe(true);
  });
});
