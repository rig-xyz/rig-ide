import { describe, expect, it, vi } from 'vitest';
import type { CommentMarker } from '../comments/comment-decorations';
import type { PreviewCommentPainter } from './comment-highlights';
import { buildPositionIndex } from './position-index';
import { previewSurfaceAdapter } from './preview-surface-adapter';
import { renderPreviewDom } from './render-preview';

/**
 * Unit coverage for the Preview `CommentSurfaceAdapter`
 * (docs/preview-mode-spec.md "Margin rail") — the seam `MarginRail` and
 * `DocCommentsStore` read through instead of an `EditorView` while Preview
 * is showing. `paintMarkers` is a thin delegate to the painter (covered by
 * its own module); this file is about `ready`/`docLength`/`coordsAtPos` —
 * the margin y-positioning contract.
 */

function fakePainter(): PreviewCommentPainter {
  return { paint: vi.fn(), hitTest: vi.fn(() => null), dispose: vi.fn() };
}

/**
 * jsdom implements no layout engine at all — `Range.prototype
 * .getBoundingClientRect` doesn't exist (see `render-preview.ts`'s own doc
 * comment on why this project builds its DOM via jsdom for `node`-project
 * tests). Patched here, scoped to the fresh jsdom `Range` class each
 * `renderPreviewDom` call returns, purely to exercise the adapter's WIRING
 * (it found a range and read a rect off it) — real pixel values only a
 * real browser can give are covered at the browser-test level.
 */
function patchRangeRect(root: HTMLElement, rect: DOMRect): void {
  const RangeCtor = root.ownerDocument.createRange().constructor as {
    prototype: { getBoundingClientRect(): DOMRect };
  };
  RangeCtor.prototype.getBoundingClientRect = () => rect;
}

const FAKE_RECT = { top: 1, bottom: 2, left: 3, right: 4 } as DOMRect;

describe('previewSurfaceAdapter', () => {
  it('is not ready before an index exists, and ready once one does', () => {
    let index: ReturnType<typeof buildPositionIndex> | null = null;
    const adapter = previewSurfaceAdapter(() => index, () => 0, fakePainter());
    expect(adapter.ready()).toBe(false);

    const source = 'hello world';
    const { root } = renderPreviewDom(source);
    index = buildPositionIndex(root, source);
    expect(adapter.ready()).toBe(true);
  });

  it('docLength reflects the current source length getter', () => {
    const adapter = previewSurfaceAdapter(
      () => null,
      () => 42,
      fakePainter()
    );
    expect(adapter.docLength()).toBe(42);
  });

  it('coordsAtPos returns null when there is no index', () => {
    const adapter = previewSurfaceAdapter(() => null, () => 0, fakePainter());
    expect(adapter.coordsAtPos(0)).toBeNull();
  });

  it('coordsAtPos resolves a real position to a rect via the index', () => {
    const source = 'hello world';
    const { root } = renderPreviewDom(source);
    patchRangeRect(root, FAKE_RECT);
    const index = buildPositionIndex(root, source);
    const adapter = previewSurfaceAdapter(() => index, () => source.length, fakePainter());

    const rect = adapter.coordsAtPos(source.indexOf('world'));
    expect(rect).toEqual({ top: 1, bottom: 2, left: 3, right: 4 });
  });

  it('coordsAtPos falls back to the last character when pos is at the end of the document', () => {
    const source = 'hello';
    const { root } = renderPreviewDom(source);
    patchRangeRect(root, FAKE_RECT);
    const index = buildPositionIndex(root, source);
    const adapter = previewSurfaceAdapter(() => index, () => source.length, fakePainter());

    expect(adapter.coordsAtPos(source.length)).not.toBeNull();
  });

  it('coordsAtPos returns null for a position the index cannot map (an empty document)', () => {
    const source = '';
    const { root } = renderPreviewDom(source);
    const index = buildPositionIndex(root, source);
    const adapter = previewSurfaceAdapter(() => index, () => source.length, fakePainter());

    expect(adapter.coordsAtPos(0)).toBeNull();
  });

  it('paintMarkers delegates straight to the painter', () => {
    const painter = fakePainter();
    const adapter = previewSurfaceAdapter(() => null, () => 0, painter);
    const markers: CommentMarker[] = [{ id: 'a', from: 0, to: 1, resolved: false, active: false }];

    adapter.paintMarkers(markers);

    expect(painter.paint).toHaveBeenCalledWith(markers);
  });
});
