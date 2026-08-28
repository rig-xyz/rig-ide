import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('leaves a document with no frontmatter untouched', () => {
    const content = '# Title\n\nSome body text.\n';
    expect(splitFrontmatter(content)).toEqual({ raw: null, body: content });
  });

  it('strips a leading frontmatter block and returns the rest as body', () => {
    const content = '---\ntitle: Notes\ntags: [a, b]\n---\n# Notes\n\nBody.\n';
    expect(splitFrontmatter(content)).toEqual({
      raw: '---\ntitle: Notes\ntags: [a, b]\n---\n',
      body: '# Notes\n\nBody.\n',
    });
  });

  it('strips a frontmatter block with one blank line and nothing else', () => {
    const content = '---\n\n---\nBody.\n';
    expect(splitFrontmatter(content)).toEqual({ raw: '---\n\n---\n', body: 'Body.\n' });
  });

  it('does not strip back-to-back delimiters with no line between them', () => {
    // The opening `---\n` already consumes the newline right after the first
    // delimiter, so the lazy `[\s\S]*?` needs a further `\n---\n` to close —
    // a genuinely empty block collapses to nothing for it to match against.
    // Faithful to the regex itself, not a case this helper tries to special-case.
    const content = '---\n---\nBody.\n';
    expect(splitFrontmatter(content)).toEqual({ raw: null, body: content });
  });

  it('returns an empty body for a document that is only frontmatter', () => {
    const content = '---\na: 1\n---\n';
    expect(splitFrontmatter(content)).toEqual({ raw: content, body: '' });
  });

  it('never strips a `---` thematic break that is not at the very start', () => {
    const content = 'Intro.\n\n---\n\nMore text.\n';
    expect(splitFrontmatter(content)).toEqual({ raw: null, body: content });
  });

  it('never strips when the document starts with whitespace before the delimiter', () => {
    const content = '\n---\ntitle: x\n---\nBody.\n';
    expect(splitFrontmatter(content)).toEqual({ raw: null, body: content });
  });

  it('requires the closing delimiter to end its own line', () => {
    // No trailing newline after the closing `---` — not a complete block.
    const content = '---\ntitle: x\n---';
    expect(splitFrontmatter(content)).toEqual({ raw: null, body: content });
  });
});
