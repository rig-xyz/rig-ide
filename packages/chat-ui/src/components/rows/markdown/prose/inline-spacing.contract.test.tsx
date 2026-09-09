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
import { applyFileMentionLinks, type LinkFileMentionsFn } from '@core/markdown/apply-file-mentions';
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

describe('chip and emphasis boundaries from the 2026-08-25 transcript report', () => {
  /**
   * Dylan's knee-ability screenshot: mention/inline-code chips mid-sentence,
   * an italic quoted string, and a bold date prefix all looked mis-spaced.
   * The probe showed the ENGINE was already correct — every boundary is
   * exactly one collapsed space — and the visual excess was the chip's own
   * padX stacking on the gap (fixed by chipOpticalInsetX, asserted below).
   * These pin the engine half so a future layout change can't regress it
   * while the optical fix takes the blame.
   */
  const CASES: [string, string, string][] = [
    ['inline-code chip mid-sentence', 'Your `@codex what do you think?` from 7/30 on the thread', '@codex what do you think?'],
    ['short chip between words', 'three unanswered `@codex` pings', '@codex'],
    ['italic quoted string after a colon', 'the share link: *"[s1-live-test] Posted through the share link."*', '"[s1-live-test] Posted through the share link."'],
    ['text after a bold date prefix', '**8/13 3:34 PM** was when codex replied', 'was when codex replied'],
  ];

  for (const [label, md, fragmentText] of CASES) {
    it(`${label}: a single source space lays out as a single space`, () => {
      const gaps = fragmentGaps(md);
      const target = gaps.find((f) => f.text === fragmentText);
      expect(target, `fragment "${fragmentText}" in ${JSON.stringify(gaps.map((g) => g.text))}`).toBeDefined();
      expect(target!.gapBefore).toBeGreaterThan(0);
      expect(target!.gapBefore).toBeLessThan(spaceWidth(fonts.body.font) * 1.5);
    });
  }

  it('chip occupied width subtracts the optical inset, so render and measurement agree', () => {
    const { chips } = DEFAULT_CONFIG;
    expect(fonts.inlineCodeExtraWidth).toBeCloseTo(2 * (chips.inlineCodePadX - chips.chipOpticalInsetX));
    expect(fonts.mentionExtraWidth).toBeCloseTo(2 * (chips.mentionPadX - chips.chipOpticalInsetX));
    // The inset must never exceed the padding, or chips would overlap text.
    expect(chips.chipOpticalInsetX).toBeLessThan(chips.mentionPadX);
    expect(chips.chipOpticalInsetX).toBeLessThan(chips.inlineCodePadX);
  });
});

describe('linkFileMentions layout parity (2026-09-08 report: "spacing before the formatted texts is wrong again")', () => {
  /**
   * Investigated with the exact layout engine `Prose.tsx` renders from —
   * `runsToRichItems` + `prepareRichInline`, run AFTER `applyFileMentionLinks`
   * exactly the way `message.def.tsx`'s measure()/AssistantRender call sites
   * do — against several realistic mention shapes: a bare multi-word phrase
   * link, a backtick-quoted file path, and two back-to-back mentions. Every
   * case came back pixel-identical (fragment x positions AND per-boundary
   * gapBefore, cross-checked against `fragmentGaps`'s own methodology above)
   * to the unlinked baseline; no reproduction of a doubled or inflated gap
   * was found despite deliberately probing the exact candidates named in the
   * report (run-splitting inserting an inter-run gap, a measure/render class
   * mismatch, a whitespace-only segment surfacing as its own run). These pin
   * that finding as a regression guard: every fragment's x (cumulative
   * gapBefore + occupiedWidth, exactly what `layoutProse` accumulates into
   * `FragmentLayout.x`) must stay byte-identical whether or not
   * `linkFileMentions` matches, except that a matched run also carries
   * `href`.
   */
  function fragmentLayoutLinked(markdown: string, matcher?: LinkFileMentionsFn) {
    const blocks = applyFileMentionLinks(parseMarkdownToBlocks('m-linked', markdown), matcher);
    const block = blocks.find((b) => b.kind === 'prose') as ProseBlock;
    const items = runsToRichItems(block.runs, fonts, block.variant);
    const prepared = prepareRichInline(items);
    const frags: { text: string; x: number; gapBefore: number; href?: string }[] = [];
    let x = 0;
    walkRichInlineLineRanges(prepared, 1e7, (range) => {
      const line = materializeRichInlineLineRange(prepared, range);
      for (const f of line.fragments) {
        x += f.gapBefore;
        frags.push({ text: f.text, x, gapBefore: f.gapBefore, href: (block.runs[f.itemIndex] as { href?: string }).href });
        x += f.occupiedWidth;
      }
    });
    return frags;
  }

  const CASES: [string, string, string, string][] = [
    [
      'bare multi-word phrase mention',
      'A low-cadence 4x6 workout was already present in the plan.',
      'low-cadence 4x6 workout',
      'x.yaml',
    ],
    [
      'bare single-word mention',
      'Z2 endurance is now linked in the profile.',
      'profile',
      'profile.md',
    ],
  ];

  for (const [label, md, needle, path] of CASES) {
    it(`${label}: fragment x-positions are unchanged from the unlinked layout, only href is added`, () => {
      const matcher: LinkFileMentionsFn = (t) => {
        const idx = t.indexOf(needle);
        if (idx === -1) return [{ text: t }];
        return [
          { text: t.slice(0, idx) },
          { text: needle, path },
          { text: t.slice(idx + needle.length) },
        ].filter((s) => s.text.length > 0);
      };

      const unlinked = fragmentLayoutLinked(md);
      const linked = fragmentLayoutLinked(md, matcher);

      // Exactly one fragment (the whole sentence) before linking; several
      // after. The linked run's own x must be exactly where that same text
      // sits within the SINGLE unlinked fragment — i.e. splitting the run
      // must never shift anything, only add `href` to the matched piece.
      expect(unlinked).toHaveLength(1);
      const linkedFrag = linked.find((f) => f.href === path);
      expect(linkedFrag?.text).toBe(needle);
      const idxInSentence = md.indexOf(needle);
      const expectedX = trueMidStringPrefixWidth(md, idxInSentence, fonts.body.font);
      expect(linkedFrag!.x).toBeCloseTo(expectedX, 0);

      // Every OTHER boundary in the linked layout is still a single
      // collapsed space, same threshold every other case in this file uses.
      const maxAllowed = spaceWidth(fonts.body.font) * 1.5;
      for (const f of linked) {
        if (f.gapBefore > 0) expect(f.gapBefore).toBeLessThan(maxAllowed);
      }
    });
  }

  /**
   * The TRUE mid-string width of `text.slice(0, prefixLen)` — i.e. where a
   * fragment starting right after that prefix actually sits when the text
   * around it keeps going (NOT `measureNaturalWidth` on the prefix in
   * isolation: a string's OWN trailing whitespace collapses to zero width
   * when it is measured as a standalone/final string, same rule as a real
   * line's trailing space never painting — appending a non-whitespace
   * sentinel and subtracting the sentinel's own width sidesteps that and
   * measures the boundary as it actually renders mid-sentence).
   */
  function trueMidStringPrefixWidth(text: string, prefixLen: number, font: string): number {
    if (prefixLen <= 0) return 0;
    const sentinel = 'X';
    const withSentinel = measureNaturalWidth(prepareWithSegments(text.slice(0, prefixLen) + sentinel, font));
    const sentinelOnly = measureNaturalWidth(prepareWithSegments(sentinel, font));
    return withSentinel - sentinelOnly;
  }

  it('a linked code-chip run does not move the surrounding text runs (href set only on the matched run)', () => {
    const md = 'See `training/workouts/torque-4x6-lowcadence.yaml` for details on the plan.';
    const path = 'training/workouts/torque-4x6-lowcadence.yaml';
    const matcher: LinkFileMentionsFn = (t) => (t === path ? [{ text: t, path }] : [{ text: t }]);

    const unlinked = fragmentLayoutLinked(md);
    const linked = fragmentLayoutLinked(md, matcher);

    expect(linked.map((f) => ({ text: f.text, x: f.x }))).toEqual(
      unlinked.map((f) => ({ text: f.text, x: f.x }))
    );
    expect(linked.find((f) => f.text === path)?.href).toBe(path);
    expect(unlinked.find((f) => f.text === path)?.href).toBeUndefined();
  });

  it('two back-to-back mentions separated by one space: every boundary is a single collapsed gap, none doubled', () => {
    const md = 'See file1.md file2.md for details.';
    const matcher: LinkFileMentionsFn = (t) => {
      const segs: { text: string; path?: string }[] = [];
      let cursor = 0;
      for (const m of t.matchAll(/file1\.md|file2\.md/g)) {
        const idx = m.index!;
        if (idx > cursor) segs.push({ text: t.slice(cursor, idx) });
        segs.push({ text: m[0], path: m[0] });
        cursor = idx + m[0].length;
      }
      if (cursor < t.length) segs.push({ text: t.slice(cursor) });
      return segs;
    };

    const linked = fragmentLayoutLinked(md, matcher);
    const maxAllowed = spaceWidth(fonts.body.font) * 1.5;

    expect(linked.map((f) => f.text)).toEqual(['See', 'file1.md', 'file2.md', 'for details.']);
    for (const f of linked) {
      if (f.gapBefore > 0) {
        expect(f.gapBefore).toBeGreaterThan(0);
        expect(f.gapBefore).toBeLessThan(maxAllowed);
      }
    }
  });
});

