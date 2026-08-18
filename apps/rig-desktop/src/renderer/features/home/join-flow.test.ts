import { describe, expect, it } from 'vitest';
import { defaultJoinDir, slugifyRigName } from './join-flow';

describe('slugifyRigName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyRigName('My Cool Rig')).toBe('my-cool-rig');
  });

  it('strips leading/trailing hyphens produced by punctuation', () => {
    expect(slugifyRigName('--Rig!!--')).toBe('rig');
  });

  it('collapses runs of non-alphanumeric characters into one hyphen', () => {
    expect(slugifyRigName('a___b   c')).toBe('a-b-c');
  });

  it('truncates to 60 characters', () => {
    expect(slugifyRigName('a'.repeat(100))).toHaveLength(60);
  });

  it('falls back to "shared-rig" for null, empty, or all-punctuation names', () => {
    expect(slugifyRigName(null)).toBe('shared-rig');
    expect(slugifyRigName('')).toBe('shared-rig');
    expect(slugifyRigName('!!!')).toBe('shared-rig');
  });
});

describe('defaultJoinDir', () => {
  it('nests the slug under ~/Rigs, tilde unexpanded', () => {
    expect(defaultJoinDir('My Cool Rig')).toBe('~/Rigs/my-cool-rig');
  });

  it('falls back honestly for an unnamed rig', () => {
    expect(defaultJoinDir(null)).toBe('~/Rigs/shared-rig');
  });
});
