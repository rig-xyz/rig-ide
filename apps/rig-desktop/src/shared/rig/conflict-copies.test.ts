import { describe, expect, it } from 'vitest';
import { conflictCopiesLabel, conflictCopyOriginal, groupConflictCopies } from './conflict-copies';

describe('conflictCopyOriginal', () => {
  it('names the file a copy came from, keeping its folder and extension', () => {
    expect(conflictCopyOriginal('notes.conflict-from.dylan-mac.chg_12.md')).toBe('notes.md');
    expect(conflictCopyOriginal('docs/plan.v2.conflict-from.laptop.chg_3.md')).toBe(
      'docs/plan.v2.md'
    );
    expect(conflictCopyOriginal('Makefile.conflict-from.laptop.chg_7')).toBe('Makefile');
  });

  it('is null for anything else', () => {
    expect(conflictCopyOriginal('notes.md')).toBeNull();
    expect(conflictCopyOriginal('notes.conflict-from.md')).toBeNull();
    expect(conflictCopyOriginal('notes.conflict-from.laptop.12.md')).toBeNull();
    expect(conflictCopyOriginal('.conflict-from.laptop.chg_1.md')).toBeNull();
    expect(conflictCopyOriginal('docs/.conflict-from.laptop.chg_1.md')).toBeNull();
  });
});

describe('groupConflictCopies', () => {
  it('folds copies into the file they came from', () => {
    const { visible, copiesByOriginal } = groupConflictCopies([
      'notes.md',
      'notes.conflict-from.mac.chg_1.md',
      'notes.conflict-from.mac.chg_2.md',
      'plan.md',
    ]);
    expect(visible).toEqual(['notes.md', 'plan.md']);
    expect(copiesByOriginal.get('notes.md')).toEqual([
      'notes.conflict-from.mac.chg_1.md',
      'notes.conflict-from.mac.chg_2.md',
    ]);
    expect(copiesByOriginal.has('plan.md')).toBe(false);
  });

  it('keeps a copy visible when its file is gone', () => {
    const { visible, copiesByOriginal } = groupConflictCopies([
      'gone.conflict-from.mac.chg_4.md',
      'plan.md',
    ]);
    expect(visible).toEqual(['gone.conflict-from.mac.chg_4.md', 'plan.md']);
    expect(copiesByOriginal.size).toBe(0);
  });

  it('matches folders exactly', () => {
    const { visible } = groupConflictCopies(['a/notes.md', 'b/notes.conflict-from.mac.chg_1.md']);
    expect(visible).toEqual(['a/notes.md', 'b/notes.conflict-from.mac.chg_1.md']);
  });
});

describe('conflictCopiesLabel', () => {
  it('reads the same for one and many', () => {
    expect(conflictCopiesLabel(1)).toBe('1 of your versions to review');
    expect(conflictCopiesLabel(9)).toBe('9 of your versions to review');
  });
});
