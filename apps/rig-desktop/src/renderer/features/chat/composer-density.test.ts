import { describe, expect, it } from 'vitest';
import { deriveComposerDensity } from './composer-density';

describe('deriveComposerDensity', () => {
  it('wide panel — full', () => {
    expect(deriveComposerDensity(640)).toBe('full');
  });

  it('at Dylan\'s reported widths (~360-420px), the narrower end goes compact', () => {
    expect(deriveComposerDensity(360)).toBe('compact');
    expect(deriveComposerDensity(420)).toBe('full');
  });

  it('exactly at the threshold is still full — the threshold is the first compact width, not the last full one', () => {
    expect(deriveComposerDensity(380)).toBe('full');
    expect(deriveComposerDensity(379)).toBe('compact');
  });

  it('zero/negative width (not yet measured) never claims compact', () => {
    expect(deriveComposerDensity(0)).toBe('full');
    expect(deriveComposerDensity(-1)).toBe('full');
  });
});
