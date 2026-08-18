import { describe, expect, it } from 'vitest';
import { defaultJoinDir, joinTargetDir, slugifyRigName } from './join-flow';

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

describe('joinTargetDir', () => {
  it('puts the rig in its own folder inside the picked one — picking ~/Code must never make ~/Code itself the rig', () => {
    expect(joinTargetDir('/Users/d/Code', 'taprig')).toBe('/Users/d/Code/taprig');
  });

  it('does not nest a second copy when the picked folder is already named for the rig', () => {
    expect(joinTargetDir('/Users/d/Code/taprig', 'taprig')).toBe('/Users/d/Code/taprig');
  });

  it('tolerates a trailing slash and an unnamed rig', () => {
    expect(joinTargetDir('/Users/d/Code/', null)).toBe('/Users/d/Code/shared-rig');
  });
});
