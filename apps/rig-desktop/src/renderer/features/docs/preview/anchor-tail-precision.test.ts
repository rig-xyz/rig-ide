import { describe, expect, it } from 'vitest';
import { buildPositionIndex } from './position-index';
import { renderPreviewDom } from './render-preview';

/**
 * A multi-line anchor whose located range ends ONE character into a word —
 * the shape a real comment gets when its quoted passage was later typed
 * past ("…- kjfd\n- f" re-anchoring against "…- kjfd\n- fsdfs"). The
 * highlight must cover exactly the anchored characters: rendered segments
 * for the fully-covered items, then just the single trailing character —
 * never the whole word the tail landed in, and never the unrendered `- `
 * markers between them (from a user-reported preview-vs-edit mismatch).
 */
describe('sourceToDom anchor-tail precision', () => {
  it('maps a mid-word range end to just the covered character', () => {
    const source = '# idk man\n\n- dfjdkfsj\n- dfdsfs\n- kjfd\n- fsdfs\n\n|||\n|-|-|\n';
    const { root } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);

    const start = source.indexOf('dfdsfs');
    const end = source.indexOf('fsdfs') + 1; // "…- f|sdfs" — one char in
    const ranges = index.sourceToDom(start, end);
    expect(ranges).not.toBeNull();
    // The bare '\n' segments are react-markdown's pretty-printing text nodes
    // between the <li>s — correct INDEX output (a cross-item DOM selection
    // really does pass through them); the highlight painter filters
    // whitespace-only segments before painting (comment-highlights.ts).
    expect((ranges ?? []).map((r) => r.toString())).toEqual(['dfdsfs', '\n', 'kjfd', '\n', 'f']);
  });
});
