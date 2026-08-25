import { describe, expect, it } from 'vitest';
import type { RigFileNode } from './files';
import { collectFileRelPaths, computeUnseenSummary, isFileUnseen } from './seen-state';

function file(relPath: string, mtimeMs?: number): RigFileNode {
  return { name: relPath.split('/').pop() ?? relPath, relPath, kind: 'file', mtimeMs };
}

function dir(relPath: string, children: RigFileNode[]): RigFileNode {
  return { name: relPath.split('/').pop() ?? relPath, relPath, kind: 'dir', children };
}

describe('isFileUnseen', () => {
  it('a never-viewed file that changed after the rig baseline is unseen', () => {
    expect(isFileUnseen(200, undefined, 100)).toBe(true);
  });

  it('a never-viewed file that predates the rig baseline is NOT unseen — day-one files never dot up', () => {
    expect(isFileUnseen(50, undefined, 100)).toBe(false);
  });

  it('a viewed file that changed again after that view is unseen', () => {
    expect(isFileUnseen(300, 200, 100)).toBe(true);
  });

  it('a viewed file that has not changed since is not unseen, even if it postdates the baseline', () => {
    expect(isFileUnseen(150, 200, 100)).toBe(false);
  });

  it('a file with no known mtime is never flagged unseen', () => {
    expect(isFileUnseen(undefined, undefined, 100)).toBe(false);
  });

  it('exactly-equal timestamps are not unseen — strictly newer only', () => {
    expect(isFileUnseen(100, undefined, 100)).toBe(false);
    expect(isFileUnseen(200, 200, 100)).toBe(false);
  });
});

describe('computeUnseenSummary', () => {
  it('flags an unseen top-level file and leaves a seen one alone', () => {
    const tree = [file('unseen.md', 200), file('seen.md', 50)];
    const { unseenFiles } = computeUnseenSummary(tree, {}, 100);
    expect(unseenFiles.has('unseen.md')).toBe(true);
    expect(unseenFiles.has('seen.md')).toBe(false);
  });

  it('rolls up a folder count from its unseen descendants, at any depth', () => {
    const tree = [
      dir('notes', [file('notes/a.md', 200), file('notes/b.md', 50), dir('notes/sub', [file('notes/sub/c.md', 300)])]),
    ];
    const { unseenCountByDir, unseenFiles } = computeUnseenSummary(tree, {}, 100);
    expect(unseenFiles.has('notes/a.md')).toBe(true);
    expect(unseenFiles.has('notes/b.md')).toBe(false);
    expect(unseenFiles.has('notes/sub/c.md')).toBe(true);
    expect(unseenCountByDir['notes']).toBe(2);
    expect(unseenCountByDir['notes/sub']).toBe(1);
  });

  it('a folder with zero unseen descendants is simply absent from the count map, not zero', () => {
    const tree = [dir('empty-of-news', [file('empty-of-news/old.md', 50)])];
    const { unseenCountByDir } = computeUnseenSummary(tree, {}, 100);
    expect('empty-of-news' in unseenCountByDir).toBe(false);
  });

  it('a per-path seen entry overrides the baseline for that file only', () => {
    const tree = [file('a.md', 300), file('b.md', 300)];
    const { unseenFiles } = computeUnseenSummary(tree, { 'a.md': 250 }, 100);
    expect(unseenFiles.has('a.md')).toBe(true); // changed again after the 250 view
    expect(unseenFiles.has('b.md')).toBe(true); // never viewed, compares to baseline 100
  });
});

describe('collectFileRelPaths', () => {
  it('collects every file relPath, flattened, skipping directory entries themselves', () => {
    const tree = [file('a.md'), dir('sub', [file('sub/b.md'), dir('sub/deeper', [file('sub/deeper/c.md')])])];
    expect(collectFileRelPaths(tree).sort()).toEqual(['a.md', 'sub/b.md', 'sub/deeper/c.md'].sort());
  });

  it('an empty tree collects nothing', () => {
    expect(collectFileRelPaths([])).toEqual([]);
  });
});
