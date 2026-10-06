import { describe, expect, it } from 'vitest';
import { findCountLabel, findOffsets } from './reading-find';

describe('findOffsets', () => {
  it('finds every occurrence, ignoring case unless asked', () => {
    expect(findOffsets('Pricing tiers and more pricing', 'pricing', false)).toEqual([
      [0, 7],
      [23, 30],
    ]);
    expect(findOffsets('Pricing tiers and more pricing', 'pricing', true)).toEqual([[23, 30]]);
  });

  it('never overlaps and finds nothing for an empty query', () => {
    expect(findOffsets('aaaa', 'aa', false)).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(findOffsets('anything', '', false)).toEqual([]);
  });
});

describe('findCountLabel', () => {
  it('says which match of how many', () => {
    expect(findCountLabel(2, 12, 'x')).toBe('3 of 12');
    expect(findCountLabel(0, 0, 'x')).toBe('No matches');
    expect(findCountLabel(0, 0, '')).toBeNull();
  });
});
