import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_RUN_VERSION } from '@shared/rig/first-run';
import { ALPHA_OFF, alphaOnly, createReadBefore, readsOnItsOwn } from './alpha';

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

  it('keeps "has read before" per account: one that chose Not now asks afresh', async () => {
    let who = 'u-a';
    const read = new Set(['u-a']);
    const hasRead = vi.fn(async () => read.has(who));
    const readBefore = createReadBefore({ whoami: async () => ok(who), hasRead });
    expect(await readBefore()).toBe(true);
    expect(await readBefore()).toBe(true);
    expect(hasRead).toHaveBeenCalledTimes(1);
    who = 'u-b';
    expect(await readBefore()).toBe(false);
    expect(await readBefore()).toBe(false);
    // B does Catch me up: from then on, B reads on its own too.
    read.add('u-b');
    expect(await readBefore()).toBe(true);
    who = 'u-a';
    expect(await readBefore()).toBe(true);
  });

  it('counts an account switch while the relay answers as no read', async () => {
    let who = 'u-a';
    const readBefore = createReadBefore({
      whoami: async () => ok(who),
      hasRead: async () => {
        who = 'u-b';
        return true;
      },
    });
    expect(await readBefore()).toBe(false);
  });
});
