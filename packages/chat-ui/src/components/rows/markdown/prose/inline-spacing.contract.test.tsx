import { DEFAULT_CONFIG, toFontConfig } from '@core/config';
import { parseMarkdownToBlocks } from '@core/markdown/parse';
import type { ProseBlock } from '@core/markdown/document';
import { prepareWithSegments, measureNaturalWidth } from '@chenglou/pretext';
import {
  materializeRichInlineLineRange,
  prepareRichInline,
  walkRichInlineLineRanges,
} from '@chenglou/pretext/rich-inline';
import { runsToRichItems } from '@core/measure/to-rich-items';
import { describe, expect, it } from 'vitest';

/**
 * Round (post-release usage, inline-spacing bug): two reported cases —
 * "at FTP = 218 W (from `profile.md` )." (extra space around an inline-
 * code chip) and "this is  *muscular*," (extra space around italic text).
 * Root-caused to `registerFontsReadyClear`'s font warm-list being
 * hardcoded and missing `italic`/`inlineCode` (among others) — see
 * `core/measure/pretext-cache.ts`/`.test.ts`, the primary regression
 * guard for the actual mechanism. This file pins the OTHER half of "fixed":
 * the layout engine itself lays out a single source space as a single
 * space at these two specific style-boundary cases, not the doubled/
 * inflated gap the bug produced — "spacing must be exactly the author's
 * characters," never invented by a fallback-vs-real-font mismatch.
 *
 * Runs in the `node` project — `@chenglou/pretext`'s measurement here is
 * pure JS/canvas-metric computation, no real browser font loading
 * involved, so this exercises the LAYOUT ENGINE'S geometry contract
 * directly rather than the font-load-timing race itself (that race is
 * `pretext-cache.test.ts`'s job) — a real, independent regression guard
 * either way: if the fragment splitter or gap calculation ever
 * reintroduces a phantom space at these boundaries, this catches it
 * regardless of what's happening with font loading.
 */

const fonts = toFontConfig(DEFAULT_CONFIG);

/** Mirrors pretext's own getCollapsedSpaceWidth: 'A A' vs 'AA'. */
function spaceWidth(font: string): number {
  return (
    measureNaturalWidth(prepareWithSegments('A A', font)) -
    measureNaturalWidth(prepareWithSegments('AA', font))
  );
}

/** The gapBefore for each laid-out fragment on one line of markdown prose. */
function fragmentGaps(markdown: string): { text: string; gapBefore: number }[] {
  const blocks = parseMarkdownToBlocks('m', markdown);
  const block = blocks.find((b) => b.kind === 'prose') as ProseBlock;
  const items = runsToRichItems(block.runs, fonts, block.variant);
  const prepared = prepareRichInline(items);
  const gaps: { text: string; gapBefore: number }[] = [];
  walkRichInlineLineRanges(prepared, 1e7, (range) => {
    const line = materializeRichInlineLineRange(prepared, range);
    for (const f of line.fragments) {
      gaps.push({ text: f.text, gapBefore: f.gapBefore });
    }
  });
  return gaps;
}

describe('inline fragment spacing at style boundaries', () => {
  it('a single source space before an inline-code chip lays out as a single space, never the doubled/phantom gap the bug produced', () => {
    const gaps = fragmentGaps('at FTP = 218 W (from `profile.md`).');
    const codeFrag = gaps.find((f) => f.text === 'profile.md');
    expect(codeFrag).toBeDefined();
    expect(codeFrag!.gapBefore).toBeGreaterThan(0);
    expect(codeFrag!.gapBefore).toBeLessThan(spaceWidth(fonts.body.font) * 1.5);
  });

  it('a single source space before an italic run lays out as a single space, never the doubled/phantom gap the bug produced', () => {
    const gaps = fragmentGaps('this is *muscular*, not fat.');
    const italicFrag = gaps.find((f) => f.text === 'muscular');
    expect(italicFrag).toBeDefined();
    expect(italicFrag!.gapBefore).toBeGreaterThan(0);
    expect(italicFrag!.gapBefore).toBeLessThan(spaceWidth(fonts.body.font) * 1.5);
  });

  it('a run of source spaces collapses to exactly one gap, per markdown whitespace semantics', () => {
    // Markdown (like HTML) collapses whitespace runs; the reported bug was a
    // too-wide gap where the author wrote ONE space, never a request to
    // preserve doubles.
    const oneSpace = fragmentGaps('this is *muscular*, not fat.');
    const twoSpaces = fragmentGaps('this is  *muscular*, not fat.');
    const gap1 = oneSpace.find((f) => f.text === 'muscular')!.gapBefore;
    const gap2 = twoSpaces.find((f) => f.text === 'muscular')!.gapBefore;
    expect(gap2).toBeCloseTo(gap1, 1);
  });
});
