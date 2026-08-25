import { describe, expect, it } from 'vitest';
import type { RigFileNode } from './files';
import { filterTree, frecencyScore, sortTree, type TreeViewContext } from './tree-view';

function file(relPath: string, opts: { mtimeMs?: number; title?: string } = {}): RigFileNode {
  return { name: relPath.split('/').pop() ?? relPath, relPath, kind: 'file', ...opts };
}

function dir(relPath: string, children: RigFileNode[]): RigFileNode {
  return { name: relPath.split('/').pop() ?? relPath, relPath, kind: 'dir', children };
}

function ctx(overrides: Partial<TreeViewContext> = {}): TreeViewContext {
  return {
    seen: {},
    unseenFiles: new Set(),
    agentWrittenFiles: new Set(),
    now: 1_000_000,
    ...overrides,
  };
}

describe('frecencyScore', () => {
  it('a file changed right now scores higher than one changed a while ago', () => {
    const now = 1_000_000;
    const recent = frecencyScore(now, undefined, now);
    const stale = frecencyScore(now - 10 * 24 * 60 * 60 * 1000, undefined, now);
    expect(recent).toBeGreaterThan(stale);
  });

  it('a recent view alone can outscore an old change alone', () => {
    const now = 1_000_000;
    const oldChangeOnly = frecencyScore(now - 30 * 24 * 60 * 60 * 1000, undefined, now);
    const recentViewOnly = frecencyScore(undefined, now, now);
    expect(recentViewOnly).toBeGreaterThan(oldChangeOnly);
  });

  it('a file with neither signal scores zero', () => {
    expect(frecencyScore(undefined, undefined, 1_000_000)).toBe(0);
  });

  it('a file recently changed AND recently viewed scores at least as high as either alone', () => {
    const now = 1_000_000;
    const both = frecencyScore(now, now, now);
    const changeOnly = frecencyScore(now, undefined, now);
    expect(both).toBeGreaterThanOrEqual(changeOnly);
  });
});

describe('sortTree', () => {
  it('alphabetical sort ignores recency entirely, folders first, then A-Z by title', () => {
    const tree = [
      file('zebra.md', { mtimeMs: 500 }),
      dir('bravo', []),
      file('alpha.md', { mtimeMs: 10 }),
    ];
    const sorted = sortTree(tree, 'alphabetical', ctx());
    expect(sorted.map((n) => n.relPath)).toEqual(['bravo', 'alpha.md', 'zebra.md']);
  });

  it('newest sort orders files by raw mtime, most recent first', () => {
    const tree = [file('old.md', { mtimeMs: 100 }), file('new.md', { mtimeMs: 900 })];
    const sorted = sortTree(tree, 'newest', ctx());
    expect(sorted.map((n) => n.relPath)).toEqual(['new.md', 'old.md']);
  });

  it('working set blends a recent view into the ranking, not just raw mtime', () => {
    const now = 1_000_000;
    const tree = [
      file('changed-long-ago-viewed-now.md', { mtimeMs: 1 }),
      file('changed-recently-never-viewed.md', { mtimeMs: now - 1000 }),
    ];
    const sorted = sortTree(
      tree,
      'workingSet',
      ctx({ now, seen: { 'changed-long-ago-viewed-now.md': now } })
    );
    // the just-viewed file's recency can outrank a file merely changed moments ago.
    expect(sorted[0].relPath).toBe('changed-long-ago-viewed-now.md');
  });

  it('unseen first groups unseen files ahead of seen ones regardless of recency', () => {
    const tree = [
      file('seen-but-newer.md', { mtimeMs: 900 }),
      file('unseen-but-older.md', { mtimeMs: 100 }),
    ];
    const sorted = sortTree(
      tree,
      'unseenFirst',
      ctx({ unseenFiles: new Set(['unseen-but-older.md']) })
    );
    expect(sorted.map((n) => n.relPath)).toEqual(['unseen-but-older.md', 'seen-but-newer.md']);
  });

  it('a folder ranks by its single best (most relevant) descendant, at any depth', () => {
    const tree = [
      dir('quiet', [file('quiet/old.md', { mtimeMs: 10 })]),
      dir('buzzing', [dir('buzzing/deep', [file('buzzing/deep/new.md', { mtimeMs: 999 })])]),
    ];
    const sorted = sortTree(tree, 'newest', ctx());
    expect(sorted.map((n) => n.relPath)).toEqual(['buzzing', 'quiet']);
  });

  it('folders always sort ahead of files within the same directory, in every sort mode', () => {
    const tree = [file('a-file.md', { mtimeMs: 999 }), dir('z-folder', [file('z-folder/x.md', { mtimeMs: 1 })])];
    for (const sort of ['workingSet', 'unseenFirst', 'newest', 'alphabetical'] as const) {
      const sorted = sortTree(tree, sort, ctx());
      expect(sorted[0].kind).toBe('dir');
    }
  });

  it('ties fall back to alphabetical order', () => {
    const tree = [file('b.md'), file('a.md')];
    const sorted = sortTree(tree, 'newest', ctx());
    expect(sorted.map((n) => n.relPath)).toEqual(['a.md', 'b.md']);
  });

  it('does not mutate the input tree', () => {
    const tree = [file('b.md', { mtimeMs: 1 }), file('a.md', { mtimeMs: 2 })];
    const original = [...tree];
    sortTree(tree, 'newest', ctx());
    expect(tree).toEqual(original);
  });
});

describe('filterTree', () => {
  it('"all" is a no-op passthrough', () => {
    const tree = [file('a.md'), dir('b', [file('b/c.md')])];
    expect(filterTree(tree, 'all', ctx())).toEqual(tree);
  });

  it('"unseen" keeps only unseen files, dropping folders left with nothing', () => {
    const tree = [
      file('unseen.md'),
      file('seen.md'),
      dir('empty-after-filter', [file('empty-after-filter/seen-too.md')]),
    ];
    const filtered = filterTree(tree, 'unseen', ctx({ unseenFiles: new Set(['unseen.md']) }));
    expect(filtered.map((n) => n.relPath)).toEqual(['unseen.md']);
  });

  it('"agents" keeps only files this app has observed an agent write to', () => {
    const tree = [file('agent-written.md'), file('human-written.md')];
    const filtered = filterTree(tree, 'agents', ctx({ agentWrittenFiles: new Set(['agent-written.md']) }));
    expect(filtered.map((n) => n.relPath)).toEqual(['agent-written.md']);
  });

  it('a folder with at least one matching descendant survives, non-matching siblings inside it do not', () => {
    const tree = [dir('mixed', [file('mixed/unseen.md'), file('mixed/seen.md')])];
    const filtered = filterTree(tree, 'unseen', ctx({ unseenFiles: new Set(['mixed/unseen.md']) }));
    expect(filtered).toEqual([dir('mixed', [file('mixed/unseen.md')])]);
  });

  it('an empty tree filters to an empty tree', () => {
    expect(filterTree([], 'unseen', ctx())).toEqual([]);
  });
});
