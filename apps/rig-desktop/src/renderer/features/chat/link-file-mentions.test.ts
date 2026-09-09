import { describe, expect, it } from 'vitest';
import type { RigFileNode } from '@shared/rig/files';
import { buildFileMentionIndex, linkFileMentions } from './link-file-mentions';

const TREE: RigFileNode[] = [
  { name: 'CLAUDE.md', relPath: 'CLAUDE.md', kind: 'file' },
  { name: 'rig.toml', relPath: 'rig.toml', kind: 'file' },
  { name: 'logo.png', relPath: 'logo.png', kind: 'file' }, // not linkable (image, not text/markdown)
  {
    name: 'docs',
    relPath: 'docs',
    kind: 'dir',
    children: [
      { name: 'notes.md', relPath: 'docs/notes.md', kind: 'file' },
      { name: 'notes.mdx', relPath: 'docs/notes.mdx', kind: 'file' },
      { name: 'What is Rig - a simple guide.md', relPath: 'docs/What is Rig - a simple guide.md', kind: 'file' },
    ],
  },
  {
    name: 'a',
    relPath: 'a',
    kind: 'dir',
    children: [{ name: 'README.md', relPath: 'a/README.md', kind: 'file' }],
  },
  {
    name: 'b',
    relPath: 'b',
    kind: 'dir',
    children: [{ name: 'README.md', relPath: 'b/README.md', kind: 'file' }],
  },
];

const ROOT = '/Users/hugorenaudin/Rig/untitled-rig';

function index(root?: string) {
  return buildFileMentionIndex(TREE, root);
}

function segTexts(segments: ReturnType<typeof linkFileMentions>): string[] {
  return segments.map((s) => s.text);
}

describe('linkFileMentions', () => {
  it('links a bare relative path that exists in the tree', () => {
    const segs = linkFileMentions('see docs/notes.md now', index());
    expect(segs).toEqual([
      { text: 'see ' },
      { text: 'docs/notes.md', path: 'docs/notes.md' },
      { text: ' now' },
    ]);
  });

  it('links a bare unique basename by itself', () => {
    const segs = linkFileMentions('open CLAUDE.md please', index());
    expect(segs).toEqual([
      { text: 'open ' },
      { text: 'CLAUDE.md', path: 'CLAUDE.md' },
      { text: ' please' },
    ]);
  });

  it('does not link an ambiguous basename shared by two files, but still links each full relPath', () => {
    const segs = linkFileMentions('README.md exists in both a/README.md and b/README.md', index());
    // The bare "README.md" at the start has no unique basename candidate, so
    // it stays plain text — but the two full relPath mentions still resolve.
    expect(segs[0]).toEqual({ text: 'README.md exists in both ' });
    const linked = segs.filter((s) => s.path);
    expect(linked).toEqual([
      { text: 'a/README.md', path: 'a/README.md' },
      { text: 'b/README.md', path: 'b/README.md' },
    ]);
  });

  it('links a quoted filename with internal spaces — the quotes stay plain text', () => {
    const segs = linkFileMentions(
      'Done — I created "What is Rig - a simple guide.md" in your workspace',
      index()
    );
    expect(segs).toEqual([
      { text: 'Done — I created "' },
      {
        text: 'What is Rig - a simple guide.md',
        path: 'docs/What is Rig - a simple guide.md',
      },
      { text: '" in your workspace' },
    ]);
  });

  it('resolves an absolute path under the workspace root to its relPath', () => {
    const segs = linkFileMentions(`cat > "${ROOT}/docs/notes.md"`, index(ROOT));
    const linked = segs.find((s) => s.path);
    expect(linked).toEqual({ text: `${ROOT}/docs/notes.md`, path: 'docs/notes.md' });
  });

  it('does not resolve an absolute path when no workspace root was supplied to the index', () => {
    const segs = linkFileMentions(`cat > "${ROOT}/docs/notes.md"`, index());
    expect(segs.some((s) => s.path)).toBe(false);
  });

  it('leaves a filename that does not exist in the tree untouched', () => {
    const segs = linkFileMentions('see missing.md now', index());
    expect(segs).toEqual([{ text: 'see missing.md now' }]);
  });

  it('never links a file whose extension the artifact pane cannot show (e.g. an image)', () => {
    const segs = linkFileMentions('see logo.png now', index());
    expect(segs).toEqual([{ text: 'see logo.png now' }]);
  });

  it('prefers the longer filename when one is a literal prefix of another (notes.md vs notes.mdx)', () => {
    const segs = linkFileMentions('see docs/notes.mdx now', index());
    expect(segs).toEqual([
      { text: 'see ' },
      { text: 'docs/notes.mdx', path: 'docs/notes.mdx' },
      { text: ' now' },
    ]);
  });

  it('does not let a shorter indexed name match inside an unrelated longer token', () => {
    // "notes.md" is indexed, but "notes.md2" here is a different, non-indexed
    // token — the trailing alnum boundary check must reject the partial match.
    const segs = linkFileMentions('see docs/notes.md2 now', index());
    expect(segs).toEqual([{ text: 'see docs/notes.md2 now' }]);
  });

  it('does not match a name immediately preceded by a path/word character (avoids matching inside a longer filename)', () => {
    const segs = linkFileMentions('see user-notes.md now', index());
    expect(segs).toEqual([{ text: 'see user-notes.md now' }]);
  });

  it('allows a leading "./" immediately before the mention', () => {
    const segs = linkFileMentions('see ./docs/notes.md now', index());
    expect(segs).toEqual([
      { text: 'see ' },
      { text: './docs/notes.md', path: 'docs/notes.md' },
      { text: ' now' },
    ]);
  });

  it('rejects a ".." parent-traversal prefix', () => {
    const segs = linkFileMentions('see ../docs/notes.md now', index());
    expect(segs).toEqual([{ text: 'see ../docs/notes.md now' }]);
  });

  it('allows a mention right before sentence-ending punctuation', () => {
    const segs = linkFileMentions('I created CLAUDE.md.', index());
    expect(segs).toEqual([
      { text: 'I created ' },
      { text: 'CLAUDE.md', path: 'CLAUDE.md' },
      { text: '.' },
    ]);
  });

  it('links multiple distinct mentions in one string', () => {
    const segs = linkFileMentions('see CLAUDE.md and rig.toml', index());
    expect(segTexts(segs)).toEqual(['see ', 'CLAUDE.md', ' and ', 'rig.toml']);
    expect(segs[1].path).toBe('CLAUDE.md');
    expect(segs[3].path).toBe('rig.toml');
  });

  it('returns the text unchanged when the tree is empty', () => {
    const segs = linkFileMentions('see CLAUDE.md now', buildFileMentionIndex([]));
    expect(segs).toEqual([{ text: 'see CLAUDE.md now' }]);
  });

  it('returns a single segment for an empty string', () => {
    expect(linkFileMentions('', index())).toEqual([{ text: '' }]);
  });
});
