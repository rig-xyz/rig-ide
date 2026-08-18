import { describe, expect, it } from 'vitest';
import type { RigFileNode } from '@shared/rig/files';
import { classifyProseLink } from './classify-prose-link';

const TREE: RigFileNode[] = [
  { name: 'CLAUDE.md', relPath: 'CLAUDE.md', kind: 'file' },
  { name: 'rig.toml', relPath: 'rig.toml', kind: 'file' },
  {
    name: 'docs',
    relPath: 'docs',
    kind: 'dir',
    children: [{ name: 'exercises.md', relPath: 'docs/exercises.md', kind: 'file' }],
  },
];

describe('classifyProseLink', () => {
  it('resolves a bare relative path that exists at the tree root', () => {
    expect(classifyProseLink('CLAUDE.md', TREE)).toEqual({
      kind: 'workspace-file',
      path: 'CLAUDE.md',
    });
  });

  it('resolves a nested relative path by recursing into directories', () => {
    expect(classifyProseLink('docs/exercises.md', TREE)).toEqual({
      kind: 'workspace-file',
      path: 'docs/exercises.md',
    });
  });

  it('strips a leading "./" before looking up the tree', () => {
    expect(classifyProseLink('./rig.toml', TREE)).toEqual({
      kind: 'workspace-file',
      path: 'rig.toml',
    });
  });

  it('falls back to external for a path the tree does not have — the quiet-no-op case', () => {
    expect(classifyProseLink('nonexistent.md', TREE)).toEqual({ kind: 'external' });
  });

  it('falls back to external when the tree has not loaded yet', () => {
    expect(classifyProseLink('CLAUDE.md', undefined)).toEqual({ kind: 'external' });
  });

  it('treats a real http(s) link as external, not a lookup candidate', () => {
    expect(classifyProseLink('https://example.com/CLAUDE.md', TREE)).toEqual({ kind: 'external' });
    expect(classifyProseLink('http://example.com', TREE)).toEqual({ kind: 'external' });
  });

  it('treats mailto:, fragment, protocol-relative and absolute hrefs as external', () => {
    expect(classifyProseLink('mailto:someone@example.com', TREE)).toEqual({ kind: 'external' });
    expect(classifyProseLink('#heading', TREE)).toEqual({ kind: 'external' });
    expect(classifyProseLink('//example.com/CLAUDE.md', TREE)).toEqual({ kind: 'external' });
    expect(classifyProseLink('/CLAUDE.md', TREE)).toEqual({ kind: 'external' });
  });

  it('refuses a path that escapes the rig root via ".."', () => {
    expect(classifyProseLink('../CLAUDE.md', TREE)).toEqual({ kind: 'external' });
    expect(classifyProseLink('docs/../../CLAUDE.md', TREE)).toEqual({ kind: 'external' });
  });

  it('matches a directory node to nothing — only files open in the artifact view', () => {
    expect(classifyProseLink('docs', TREE)).toEqual({ kind: 'external' });
  });

  it('decodes a URL-encoded relative path before lookup', () => {
    const tree: RigFileNode[] = [{ name: 'my doc.md', relPath: 'my doc.md', kind: 'file' }];
    expect(classifyProseLink('my%20doc.md', tree)).toEqual({
      kind: 'workspace-file',
      path: 'my doc.md',
    });
  });
});
