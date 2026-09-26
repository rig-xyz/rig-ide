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

  it('is true while the mode is on as just you (comment mode, canvas board 16)', () => {
    expect(isPaintbrushArmed({ on: true, mention: null })).toBe(true);
  });

  it('is true while the mode is on with an agent picked', () => {
    expect(isPaintbrushArmed({ on: true, mention: MENTION })).toBe(true);
  });
});
