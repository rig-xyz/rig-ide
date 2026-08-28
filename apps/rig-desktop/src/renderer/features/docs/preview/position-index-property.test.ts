import { describe, expect, it } from 'vitest';
import { FIXTURES } from './fixtures';
import { buildPositionIndex } from './position-index';
import { renderPreviewDom } from './render-preview';

/**
 * The spec's property test (docs/preview-mode-spec.md, Rollout step 1):
 * "for any selection range in rendered DOM, the mapped source slice's
 * rendered form equals the selected text."
 *
 * Precise definition used here — a forward/backward ROUND TRIP, not an
 * independent re-implementation of markdown rendering (which would just be
 * a second copy of `text-alignment.ts` to keep in sync with the first):
 *
 *   1. Pick a random DOM Range within a rendered fixture (`domText` = its
 *      `.toString()` — exactly what a real selection would report).
 *   2. `rangeToSource(range)` → a source span. A `null` result isn't a
 *      counterexample (an unmapped span is `rangeToSource` correctly
 *      declining to guess) — it's excluded from the check.
 *   3. `sourceToDom(start, end)` on that SAME span → DOM range(s). Their
 *      concatenated `.toString()` is that source span's "rendered form" —
 *      it went through the exact same escape/entity/marker-stripping logic
 *      `domToSource` used to build the mapping in the first place.
 *   4. Assert step 3's text equals `domText` from step 1, WHITESPACE RUNS
 *      COLLAPSED on both sides first. This is deliberate, not a loosened
 *      check papering over a bug: mdast-util-to-hast inserts its own
 *      whitespace-only text nodes ("\n") to pretty-print HTML between
 *      block siblings at every nesting level — e.g. a doubly-nested list
 *      item closing produces THREE stacked "\n" text nodes (one per
 *      closing level) where the source has exactly ONE real newline. Only
 *      the outermost of those is a real character; the rest are pure
 *      rendering artifacts with no source position at all, and a random
 *      DOM range crossing that boundary legitimately selects all of them —
 *      `domText` includes them, `reconstructed` correctly can't (there is
 *      nothing in the source to map them to). A step 4 that demanded exact
 *      equality would be asserting the index can reconstruct whitespace
 *      that was never real to begin with. Any NON-whitespace discrepancy
 *      still fails the check — this only tolerates whitespace amount.
 *
 * This is deterministic: a seeded PRNG (mulberry32 — no dependency needed
 * for one small generator) picks boundary points, so a failure always
 * reproduces from the printed seed/fixture/iteration.
 */

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BoundaryPoint = { node: Text; offset: number };

/** Every valid (Text node, offset) boundary point in `root`, in document order. */
function allBoundaryPoints(root: HTMLElement): BoundaryPoint[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const points: BoundaryPoint[] = [];
  let n = walker.nextNode();
  while (n) {
    const t = n as Text;
    for (let offset = 0; offset <= t.data.length; offset++) points.push({ node: t, offset });
    n = walker.nextNode();
  }
  return points;
}

function pickRange(document: Document, points: BoundaryPoint[], rand: () => number): Range | null {
  if (points.length < 2) return null;
  const i = Math.floor(rand() * points.length);
  const j = Math.floor(rand() * points.length);
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  if (lo === hi) return null; // Collapsed — nothing to select.
  const range = document.createRange();
  range.setStart(points[lo]!.node, points[lo]!.offset);
  range.setEnd(points[hi]!.node, points[hi]!.offset);
  return range;
}

const ITERATIONS_PER_FIXTURE = 500;
const SEEDS = [0x5eed_1234, 0x1234_5eed, 0xc0ffee];

describe('position index property test: DOM range round trip', () => {
  const cases = FIXTURES.flatMap((source, i) => SEEDS.map((seed) => ({ source, i, seed })));

  it.each(cases)(
    'fixture #$i, seed $seed: every random range round-trips through source and back to the same text',
    ({ source, seed }) => {
      const { root, document } = renderPreviewDom(source);
      const index = buildPositionIndex(root, source);
      const points = allBoundaryPoints(root);
      const rand = mulberry32(seed);

      let checked = 0;
      for (let iter = 0; iter < ITERATIONS_PER_FIXTURE; iter++) {
        const range = pickRange(document, points, rand);
        if (!range) continue;
        const domText = range.toString();
        if (domText.length === 0) continue;

        const mapped = index.rangeToSource(range);
        if (!mapped || mapped.end <= mapped.start) continue; // Not a counterexample — see module doc.

        const back = index.sourceToDom(mapped.start, mapped.end);
        expect(
          back,
          `iteration ${iter}: sourceToDom(${mapped.start}, ${mapped.end}) returned null for a span rangeToSource just produced from "${domText}"`
        ).not.toBeNull();
        const reconstructed = back!.map((r) => r.toString()).join('');
        expect(
          collapseWhitespace(reconstructed),
          `iteration ${iter}: round trip mismatch for source.slice(${mapped.start}, ${mapped.end}) = ${JSON.stringify(source.slice(mapped.start, mapped.end))}`
        ).toBe(collapseWhitespace(domText));
        checked++;
      }

      // A near-zero count would mean the loop silently checked nothing —
      // as suspicious as an outright failure for a document this size.
      expect(checked).toBeGreaterThan(ITERATIONS_PER_FIXTURE / 4);
    }
  );
});
