import { describe, expect, it } from 'vitest';
import { buildAnchorFromRange, reanchor } from '../comments/anchors';
import { buildPositionIndex } from './position-index';
import { renderPreviewDom } from './render-preview';

/**
 * The spec's own cross-surface gate (docs/preview-mode-spec.md, rollout step
 * 3(a)): "a comment created in Preview on a selection crossing a bold span
 * exact-locates in Edit mode" — i.e. via `anchors.ts`, the SAME quote-locate
 * ladder Edit mode and the CM6 decorations use. This is the hole the whole
 * position-index mechanism exists to close (see `position-index.test.ts`'s
 * "selections crossing formatting boundaries" describe block, which this
 * test picks up right where it leaves off): a DOM selection spanning from
 * plain text into a `**bold**` span, carried all the way through
 * `rangeToSource` → `buildAnchorFromRange` → `reanchor`, proving the
 * resulting anchor is real, verbatim, marker-including source text that
 * exact-locates — never an orphan.
 */
describe('cross-surface anchor gate: Preview selection → anchor → exact-locate', () => {
  it('a selection crossing plain text into a bold span produces a marker-including, exact-locating anchor', () => {
    const source = 'Please see **the attached document** for details.';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);

    // The exact DOM selection a reader would make: "see" (plain) through
    // "for" (plain again), crossing the entire bold span in between.
    const p = root.querySelector('p')!;
    const before = p.firstChild as Text; // "Please see "
    const after = p.lastChild as Text; // " for details."
    const range = document.createRange();
    range.setStart(before, before.data.indexOf('see'));
    range.setEnd(after, after.data.indexOf('for') + 3);

    // 1. DOM selection → SOURCE range (the position index).
    const mapped = index.rangeToSource(range);
    expect(mapped).not.toBeNull();
    const { start, end } = mapped!;

    // 2. SOURCE range → anchor (never refuses — this is the whole point of
    //    the from-range builder over `buildAnchor`'s verbatim search).
    const anchor = buildAnchorFromRange(source, start, end);
    expect(anchor.exact).toBe('see **the attached document** for');
    // Markers included — the exact text the DOM never rendered at all.
    expect(anchor.exact).toContain('**');
    expect(source.slice(start, end)).toBe(anchor.exact);

    // 3. The anchor exact-locates via `anchors.ts` — the SAME ladder Edit
    //    mode's CM6 decorations and the relay's own re-anchoring use. No
    //    orphan, no whitespace-normalized fallback: a unique, offset-bearing
    //    match.
    const located = reanchor(source, anchor);
    expect(located).toEqual({ status: 'anchored', index: start });
  });

  it('a selection starting mid-word inside bold and ending mid-word in plain text also exact-locates', () => {
    const source = 'a **bold** word';
    const { root, document } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);

    const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
    const bold = textNodes.find((t) => t.data.includes('bold'))!;
    const word = textNodes.find((t) => t.data.includes('word'))!;

    const range = document.createRange();
    range.setStart(bold, bold.data.indexOf('bold') + 2); // "ld" of "bold"
    range.setEnd(word, word.data.indexOf('word') + 2); // "wo" of "word"

    const mapped = index.rangeToSource(range);
    expect(mapped).not.toBeNull();
    const { start, end } = mapped!;

    const anchor = buildAnchorFromRange(source, start, end);
    expect(anchor.exact).toBe('ld** wo');
    expect(source.slice(start, end)).toBe(anchor.exact);

    const located = reanchor(source, anchor);
    expect(located).toEqual({ status: 'anchored', index: start });
  });
});
