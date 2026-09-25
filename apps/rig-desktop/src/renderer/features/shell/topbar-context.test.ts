import { describe, expect, it } from 'vitest';
import { deriveBoundIsSpace, deriveTopbarContext } from './topbar-context';

describe('deriveTopbarContext', () => {
  it('shows nothing on Home (bound is null) — no mini-breadcrumb, no title', () => {
    expect(deriveTopbarContext(null)).toEqual({ kind: 'none' });
  });

  it('drives the [⌂] › rig-name mini-breadcrumb once a rig is bound', () => {
    expect(deriveTopbarContext({ name: 'rig', bindingId: 'b1', path: '/rigs/rig' })).toEqual({
      kind: 'rig',
      name: 'rig',
      bindingId: 'b1',
      path: '/rigs/rig',
    });
  });

  it('falls back to "Unnamed rig" when the bound rig has no name', () => {
    expect(deriveTopbarContext({ name: null, bindingId: 'b1', path: '/rigs/rig' })).toEqual({
      kind: 'rig',
      name: 'Unnamed rig',
      bindingId: 'b1',
      path: '/rigs/rig',
    });
  });
});

describe('deriveBoundIsSpace', () => {
  const base = { spacesEnabled: true, bindingId: 'b1', listedKind: undefined, openedAsSpace: false } as const;

  it('reads the workspaces listing once it names the binding', () => {
    expect(deriveBoundIsSpace({ ...base, listedKind: 'space' })).toBe(true);
    expect(deriveBoundIsSpace({ ...base, listedKind: 'rig' })).toBe(false);
  });

  it('treats a just-created/joined space as a space before the listing names it', () => {
    expect(deriveBoundIsSpace({ ...base, openedAsSpace: true })).toBe(true);
    expect(deriveBoundIsSpace(base)).toBe(false);
  });

  it('lets the listing overrule an open started as a space', () => {
    expect(deriveBoundIsSpace({ ...base, openedAsSpace: true, listedKind: 'rig' })).toBe(false);
  });

  it('is never a space with nothing bound or spaces off', () => {
    expect(deriveBoundIsSpace({ ...base, bindingId: null, openedAsSpace: true })).toBe(false);
    expect(deriveBoundIsSpace({ ...base, spacesEnabled: false, listedKind: 'space' })).toBe(false);
  });
});
