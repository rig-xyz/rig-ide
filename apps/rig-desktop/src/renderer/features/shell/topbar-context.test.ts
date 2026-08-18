import { describe, expect, it } from 'vitest';
import { deriveTopbarContext } from './topbar-context';

describe('deriveTopbarContext', () => {
  it('shows nothing on Home (bound is null) — no mini-breadcrumb, no title', () => {
    expect(deriveTopbarContext(null)).toEqual({ kind: 'none' });
  });

  it('drives the [⌂] › rig-name mini-breadcrumb once a rig is bound', () => {
    expect(deriveTopbarContext({ name: 'rig', bindingId: 'b1' })).toEqual({
      kind: 'rig',
      name: 'rig',
      bindingId: 'b1',
    });
  });

  it('falls back to "Unnamed rig" when the bound rig has no name', () => {
    expect(deriveTopbarContext({ name: null, bindingId: 'b1' })).toEqual({
      kind: 'rig',
      name: 'Unnamed rig',
      bindingId: 'b1',
    });
  });
});
