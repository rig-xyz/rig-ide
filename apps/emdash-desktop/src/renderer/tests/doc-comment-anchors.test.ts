import { describe, expect, it } from 'vitest';
import { buildAnchor, groupThreads, reanchor } from '@renderer/features/docs/comments/anchors';

/**
 * These mirror the rig CLI's anchor behavior (`rig/src/comment-anchors.mjs`).
 * If one of them starts failing, the desktop app has drifted from the CLI and
 * the web hub and would place the same comment somewhere else.
 */

describe('reanchor', () => {
  it('anchors a unique match at its offset', () => {
    const text = 'Intro line.\nThe quick brown fox jumps.\nOutro.';
    const result = reanchor(text, { exact: 'quick brown fox' });

    expect(result).toEqual({ status: 'anchored', index: text.indexOf('quick brown fox') });
  });

  it('treats an anchor-less comment as file-level', () => {
    expect(reanchor('anything', null)).toEqual({ status: 'file-level' });
    expect(reanchor('anything', { exact: '' })).toEqual({ status: 'file-level' });
  });

  it('disambiguates repeated matches with the recorded prefix/suffix', () => {
    const text = 'alpha TARGET omega\n\nbeta TARGET gamma\n';
    const second = text.lastIndexOf('TARGET');

    const result = reanchor(text, { exact: 'TARGET', prefix: 'beta ', suffix: ' gamma' });

    expect(result).toEqual({ status: 'anchored', index: second });
  });

  it('prefers the occurrence matching the most context, not the first one', () => {
    const text = 'one HIT two\nthree HIT four\n';
    // Only the suffix is right for the second occurrence; prefix matches neither.
    const result = reanchor(text, { exact: 'HIT', prefix: 'zzzzz ', suffix: ' four' });

    expect(result).toEqual({ status: 'anchored', index: text.lastIndexOf('HIT') });
  });

  it('falls back to a whitespace-normalized match, without an offset', () => {
    // The document has been reflowed: same words, different line breaks.
    const text = 'A sentence that was\nrewrapped across lines.';
    const result = reanchor(text, { exact: 'that was rewrapped across' });

    expect(result).toEqual({ status: 'anchored', normalized: true });
    expect(result).not.toHaveProperty('index');
  });

  it('reports an orphan when the quoted passage is gone', () => {
    const result = reanchor('The paragraph was rewritten entirely.', {
      exact: 'a sentence that no longer exists',
      prefix: 'before ',
      suffix: ' after',
    });

    expect(result).toEqual({ status: 'orphan' });
  });
});

describe('buildAnchor', () => {
  it('captures ~32 chars of real surrounding text', () => {
    const text = `${'a'.repeat(50)}QUOTE${'b'.repeat(50)}`;
    const built = buildAnchor(text, 'QUOTE');

    expect(built).toEqual({
      ok: true,
      anchor: { exact: 'QUOTE', prefix: 'a'.repeat(32), suffix: 'b'.repeat(32) },
    });
  });

  it('refuses a quote that is not verbatim, flagging a whitespace-only mismatch', () => {
    const text = 'Words split\nover two lines.';

    expect(buildAnchor(text, 'Words split over two')).toEqual({ ok: false, whitespaceOnly: true });
    expect(buildAnchor(text, 'not in the document')).toEqual({ ok: false, whitespaceOnly: false });
  });
});

describe('groupThreads', () => {
  const message = (id: string, parentId: string | null = null) => ({ id, parentId });

  it('groups replies under their root', () => {
    const groups = groupThreads([
      message('root-1'),
      message('reply-1', 'root-1'),
      message('root-2'),
      message('reply-2', 'root-1'),
    ]);

    expect(groups).toEqual([
      {
        root: message('root-1'),
        replies: [message('reply-1', 'root-1'), message('reply-2', 'root-1')],
      },
      { root: message('root-2'), replies: [] },
    ]);
  });

  it('promotes an orphaned reply to its own thread rather than dropping it', () => {
    const groups = groupThreads([message('root-1'), message('stray', 'missing-root')]);

    expect(groups).toEqual([
      { root: message('root-1'), replies: [] },
      { root: message('stray', 'missing-root'), replies: [] },
    ]);
  });
});
