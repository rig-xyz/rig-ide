import { describe, expect, it } from 'vitest';
import { isPaintbrushArmed } from './paintbrush-gating';

const MENTION = { providerId: 'claude', name: 'Claude' };

describe('isPaintbrushArmed', () => {
  it('is false when paintbrush wiring is absent entirely (every pre-paintbrush caller)', () => {
    expect(isPaintbrushArmed(undefined)).toBe(false);
  });

  it('is false while the mode is off, even with an agent chosen', () => {
    expect(isPaintbrushArmed({ on: false, mention: MENTION })).toBe(false);
  });

  it('is false while the mode is on but no agent has been chosen yet', () => {
    expect(isPaintbrushArmed({ on: true, mention: null })).toBe(false);
  });

  it('is true only once both the mode is on and an agent is chosen', () => {
    expect(isPaintbrushArmed({ on: true, mention: MENTION })).toBe(true);
  });
});
