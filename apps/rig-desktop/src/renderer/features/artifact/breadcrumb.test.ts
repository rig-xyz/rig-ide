import { describe, expect, it } from 'vitest';
import { breadcrumbSegments } from './breadcrumb';

describe('breadcrumbSegments', () => {
  it('splits nested folders into their own segments, each carrying its own relPath', () => {
    const segments = breadcrumbSegments(
      '/Users/dylan/knee-ability-rig',
      '/Users/dylan/knee-ability-rig/docs/progression-tracking-prd.md'
    );
    expect(segments).toEqual([
      { label: 'docs', kind: 'folder', relPath: 'docs' },
      { label: 'progression-tracking-prd.md', kind: 'file' },
    ]);
  });

  it('renders a file at the rig root as a single filename segment — no root crumb of any kind', () => {
    expect(breadcrumbSegments('/rig', '/rig/README.md')).toEqual([
      { label: 'README.md', kind: 'file' },
    ]);
  });

  it('accumulates relPath per folder depth for nested folders', () => {
    const segments = breadcrumbSegments('/rig', '/rig/a/b/c/deep.md');
    expect(segments).toEqual([
      { label: 'a', kind: 'folder', relPath: 'a' },
      { label: 'b', kind: 'folder', relPath: 'a/b' },
      { label: 'c', kind: 'folder', relPath: 'a/b/c' },
      { label: 'deep.md', kind: 'file' },
    ]);
  });
});
