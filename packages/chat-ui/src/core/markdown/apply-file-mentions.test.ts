/**
 * apply-file-mentions.test.ts — unit tests for the post-parse file-mention
 * linking pass. Uses a fake `linkFileMentions` matcher (the real matcher
 * lives host-side, e.g. apps/rig-desktop's `link-file-mentions.ts`) so these
 * tests exercise only the run-splitting / memoization contract.
 */

import { describe, expect, it } from 'vitest';
import type { FileMentionSegment } from '@/commands';
import { applyFileMentionLinks } from './apply-file-mentions';
import type { Block, CodeBlock, InlineCode, InlineText, ProseBlock } from './document';

function prose(id: string, runs: ProseBlock['runs']): ProseBlock {
  return { kind: 'prose', id, variant: 'body', runs };
}

function textRun(text: string, extra: Partial<InlineText> = {}): InlineText {
  return { kind: 'text', text, ...extra };
}

/** Matches `docs/notes.md` anywhere in the text as a single segment. */
const matchNotesMd = (text: string): FileMentionSegment[] => {
  const needle = 'docs/notes.md';
  const idx = text.indexOf(needle);
  if (idx === -1) return [{ text }];
  return [
    { text: text.slice(0, idx) },
    { text: needle, path: needle },
    { text: text.slice(idx + needle.length) },
  ].filter((s) => s.text.length > 0 || s.path);
};

describe('applyFileMentionLinks', () => {
  it('returns the same array reference when no matcher is supplied', () => {
    const blocks: Block[] = [prose('a', [textRun('see docs/notes.md now')])];
    expect(applyFileMentionLinks(blocks)).toBe(blocks);
  });

  it('splits a matching bare mention out of a plain text run, preserving surrounding text', () => {
    const blocks: Block[] = [prose('a', [textRun('see docs/notes.md now')])];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    const runs = (linked[0] as ProseBlock).runs as InlineText[];
    expect(runs.map((r) => [r.text, r.href])).toEqual([
      ['see ', undefined],
      ['docs/notes.md', 'docs/notes.md'],
      [' now', undefined],
    ]);
  });

  it('leaves a run with no match untouched (same block reference)', () => {
    const blocks: Block[] = [prose('a', [textRun('nothing to see here')])];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    expect(linked[0]).toBe(blocks[0]);
  });

  it('never relinks a run that already has an href (a real markdown link)', () => {
    const blocks: Block[] = [prose('a', [textRun('docs/notes.md', { href: 'elsewhere.md' })])];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    const runs = (linked[0] as ProseBlock).runs as InlineText[];
    expect(runs).toEqual([textRun('docs/notes.md', { href: 'elsewhere.md' })]);
  });

  it('preserves bold/italic/strike on both the linked and plain segments', () => {
    const blocks: Block[] = [
      prose('a', [textRun('see docs/notes.md now', { bold: true, italic: true })]),
    ];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    const runs = (linked[0] as ProseBlock).runs as InlineText[];
    for (const r of runs) {
      expect(r.bold).toBe(true);
      expect(r.italic).toBe(true);
    }
  });

  it('links an inline code span only when the whole span text matches', () => {
    const codeRun: InlineCode = { kind: 'code', text: 'docs/notes.md' };
    const blocks: Block[] = [prose('a', [codeRun])];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    const runs = (linked[0] as ProseBlock).runs as InlineCode[];
    expect(runs).toEqual([{ kind: 'code', text: 'docs/notes.md', href: 'docs/notes.md' }]);
  });

  it('does not link an inline code span that only partially matches', () => {
    const codeRun: InlineCode = { kind: 'code', text: 'see docs/notes.md now' };
    const blocks: Block[] = [prose('a', [codeRun])];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    expect((linked[0] as ProseBlock).runs).toEqual([codeRun]);
  });

  it('ignores a matcher that fails to reconstruct the original text', () => {
    const brokenMatcher = (): FileMentionSegment[] => [{ text: 'totally different', path: 'x.md' }];
    const blocks: Block[] = [prose('a', [textRun('see docs/notes.md now')])];
    const linked = applyFileMentionLinks(blocks, brokenMatcher);
    expect(linked[0]).toBe(blocks[0]);
  });

  it('passes non-prose blocks through unchanged', () => {
    const codeBlock: CodeBlock = { kind: 'code', id: 'c', code: 'docs/notes.md' };
    const blocks: Block[] = [codeBlock];
    const linked = applyFileMentionLinks(blocks, matchNotesMd);
    expect(linked[0]).toBe(codeBlock);
  });

  it('memoizes by (blocks identity, matcher identity) — same inputs return the same result object', () => {
    const blocks: Block[] = [prose('a', [textRun('see docs/notes.md now')])];
    const first = applyFileMentionLinks(blocks, matchNotesMd);
    const second = applyFileMentionLinks(blocks, matchNotesMd);
    expect(second).toBe(first);
  });

  it('recomputes when the matcher reference changes for the same blocks', () => {
    const blocks: Block[] = [prose('a', [textRun('see docs/notes.md now')])];
    const first = applyFileMentionLinks(blocks, matchNotesMd);
    const otherMatcher = (text: string): FileMentionSegment[] => matchNotesMd(text);
    const second = applyFileMentionLinks(blocks, otherMatcher);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('leaves a lone space between two back-to-back mentions as its own run (neither neighbour is plain text to fold into)', () => {
    const matchTwoFiles = (text: string): FileMentionSegment[] => {
      const segs: FileMentionSegment[] = [];
      let cursor = 0;
      for (const m of text.matchAll(/file1\.md|file2\.md/g)) {
        const idx = m.index!;
        if (idx > cursor) segs.push({ text: text.slice(cursor, idx) });
        segs.push({ text: m[0], path: m[0] });
        cursor = idx + m[0].length;
      }
      if (cursor < text.length) segs.push({ text: text.slice(cursor) });
      return segs;
    };
    const blocks: Block[] = [prose('a', [textRun('see file1.md file2.md now')])];
    const linked = applyFileMentionLinks(blocks, matchTwoFiles);
    const runs = (linked[0] as ProseBlock).runs as InlineText[];
    expect(runs.map((r) => [r.text, r.href])).toEqual([
      ['see ', undefined],
      ['file1.md', 'file1.md'],
      [' ', undefined],
      ['file2.md', 'file2.md'],
      [' now', undefined],
    ]);
  });

  it('folds a plain whitespace-only segment into the preceding plain run instead of becoming its own run', () => {
    // A (deliberately over-eager) matcher that chops the plain text either
    // side of the one real match into extra whitespace-only segments —
    // exercises the merge without depending on any particular real matcher
    // ever producing this shape.
    const matchWithExtraSplits = (text: string): FileMentionSegment[] => {
      const needle = 'docs/notes.md';
      const idx = text.indexOf(needle);
      if (idx === -1) return [{ text }];
      return [
        { text: text.slice(0, idx - 1) },
        { text: text.slice(idx - 1, idx) }, // the single boundary space, its own segment
        { text: needle, path: needle },
        { text: text.slice(idx + needle.length) },
      ].filter((s) => s.text.length > 0);
    };
    const blocks: Block[] = [prose('a', [textRun('see docs/notes.md now')])];
    const linked = applyFileMentionLinks(blocks, matchWithExtraSplits);
    const runs = (linked[0] as ProseBlock).runs as InlineText[];
    // Same 3-run shape as the non-split matcher above — the whitespace
    // segment never surfaces as a run of its own.
    expect(runs.map((r) => [r.text, r.href])).toEqual([
      ['see ', undefined],
      ['docs/notes.md', 'docs/notes.md'],
      [' now', undefined],
    ]);
  });
});
