import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { createHomeSpace } from './home-space';

function deps(spaces: { bindingId: string; name: string; root: string | null }[], id: string | null = null) {
  let saved = id;
  return {
    homeSpaceId: () => saved,
    setHomeSpaceId: vi.fn((v: string) => (saved = v)),
    spaces: vi.fn(async () => ok(spaces)),
    create: vi.fn(async (name: string) => ok({ bindingId: 'b_new', root: `/Rig/${name}` })),
    saved: () => saved,
  };
}

describe('the Home space', () => {
  it('makes one when there is none, once however often it is asked, and remembers it', async () => {
    const d = deps([{ bindingId: 'b_ops', name: 'ops', root: '/Rig/ops' }]);
    const home = createHomeSpace(d);
    const [a, b] = await Promise.all([home.ensure(), home.ensure()]);
    expect(a).toEqual(ok({ bindingId: 'b_new', root: '/Rig/home' }));
    expect(b).toEqual(a);
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.create).toHaveBeenCalledWith('home');
    expect(d.saved()).toBe('b_new');
  });

  it('neither looks one up nor makes one with Rig Alpha off', async () => {
    const d = deps([]);
    const home = createHomeSpace({ ...d, alphaOn: () => false });
    expect(await home.ensure()).toEqual(err('Rig Alpha is off (Settings › Advanced).'));
    expect(d.spaces).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
  });

  it('uses the one it remembers, or adopts a space called home already on this Mac', async () => {
    const remembered = deps([{ bindingId: 'b_h', name: 'home', root: '/Rig/home' }], 'b_h');
    expect(await createHomeSpace(remembered).ensure()).toEqual(ok({ bindingId: 'b_h', root: '/Rig/home' }));
    const adopted = deps([{ bindingId: 'b_h2', name: 'home', root: '/Rig/home-2' }]);
    expect(await createHomeSpace(adopted).ensure()).toEqual(ok({ bindingId: 'b_h2', root: '/Rig/home-2' }));
    expect(adopted.saved()).toBe('b_h2');
    expect(adopted.create).not.toHaveBeenCalled();
  });

  it("says so when it can't be made", async () => {
    const d = { ...deps([]), create: vi.fn(async () => err('no folder')) };
    expect(await createHomeSpace(d).ensure()).toEqual(err('no folder'));
  });
});
