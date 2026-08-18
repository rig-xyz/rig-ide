import { describe, expect, it } from 'vitest';
import { compactOptionLabel } from './option-label';

describe('compactOptionLabel', () => {
  it('strips a trailing parenthetical annotation', () => {
    expect(compactOptionLabel('Default (recommended)')).toBe('Default');
  });

  it('leaves a name with no parenthetical untouched', () => {
    expect(compactOptionLabel('Claude Opus 4.5')).toBe('Claude Opus 4.5');
  });

  it('leaves a name with a parenthetical in the MIDDLE untouched (only a trailing one is an annotation)', () => {
    expect(compactOptionLabel('GPT-5 (Preview) Turbo')).toBe('GPT-5 (Preview) Turbo');
  });

  it('falls back to the original name if stripping would leave nothing', () => {
    expect(compactOptionLabel('(recommended)')).toBe('(recommended)');
  });

  it('trims incidental whitespace left behind', () => {
    expect(compactOptionLabel('High   (default)')).toBe('High');
  });
});
