import { describe, expect, it } from 'vitest';
import { generateSpaceName } from './space-create';

describe('generateSpaceName', () => {
  it('produces a two-word, lowercase, hyphenated name', () => {
    const name = generateSpaceName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('is deterministic for a given random sequence', () => {
    const a = generateSpaceName(new Set(), () => 0);
    const b = generateSpaceName(new Set(), () => 0);
    expect(a).toBe(b);
  });

  it('avoids a name already in use, falling back to a numbered suffix once every pair is taken', () => {
    const first = generateSpaceName(new Set(), () => 0);
    const second = generateSpaceName(new Set([first]), () => 0);
    expect(second).not.toBe(first);
    expect(second).toBe(`${first}-2`);
  });

  it('treats existing names case-insensitively', () => {
    const first = generateSpaceName(new Set(), () => 0);
    const second = generateSpaceName(new Set([first.toUpperCase()]), () => 0);
    expect(second).not.toBe(first);
  });
});
