import { describe, expect, it } from 'vitest';
import { nextUntitledFileName } from './add-menu-logic';

describe('nextUntitledFileName', () => {
  it('starts at untitled-1.md in an empty (or untitled-free) root', () => {
    expect(nextUntitledFileName([])).toBe('untitled-1.md');
    expect(nextUntitledFileName(['CLAUDE.md', 'rig.toml'])).toBe('untitled-1.md');
  });

  it('skips every taken number, not just the first', () => {
    expect(nextUntitledFileName(['untitled-1.md'])).toBe('untitled-2.md');
    expect(nextUntitledFileName(['untitled-1.md', 'untitled-2.md', 'untitled-3.md'])).toBe(
      'untitled-4.md'
    );
  });

  it('finds the first GAP rather than always appending at the end', () => {
    expect(nextUntitledFileName(['untitled-1.md', 'untitled-3.md'])).toBe('untitled-2.md');
  });

  it('accepts a Set directly, same result as an array', () => {
    expect(nextUntitledFileName(new Set(['untitled-1.md']))).toBe('untitled-2.md');
  });
});
