import type { CommentSurfaceAdapter, SurfaceRect } from '../comments/surface-adapter';
import type { PreviewCommentPainter } from './comment-highlights';
import type { PositionIndex } from './position-index';

/**
 * The Preview pane's `CommentSurfaceAdapter` (docs/preview-mode-spec.md
 * "Margin rail") — the rendered-DOM counterpart to `comment-decorations.ts`'s
 * `cm6SurfaceAdapter`. `paintMarkers` delegates straight to the highlight
 * painter (`comment-highlights.ts`); `coordsAtPos` asks the position index
 * for the DOM range at a source offset (`sourceToDom`) and reads its
 * viewport rect — the same "where is this text position on screen" question
 * CM6's own `coordsAtPos` answers, just sourced from the index instead of an
 * `EditorView`.
 *
 * `getIndex`/`getSourceLength` are getters, not values: the index is rebuilt
 * on every content/DOM change (`preview-pane.tsx`), so the adapter must
 * always read the CURRENT one rather than close over a stale snapshot.
 */
export function previewSurfaceAdapter(
  getIndex: () => PositionIndex | null,
  getSourceLength: () => number,
  painter: PreviewCommentPainter
): CommentSurfaceAdapter {
  return {
    ready: () => getIndex() !== null,
    docLength: getSourceLength,
    coordsAtPos: (pos) => rectAtSourcePos(getIndex(), getSourceLength(), pos),
    paintMarkers: (markers) => painter.paint(markers),
  };
}

function rectAtSourcePos(
  index: PositionIndex | null,
  sourceLength: number,
  pos: number
): SurfaceRect | null {
  if (!index) return null;
  // A source range of at least one character is required to resolve a DOM
  // range at all; a position at (or past) the very end of the document has
  // no character starting there, so fall back to measuring the one just
  // before it instead — same "nearest caret" leniency CM6's own
  // `coordsAtPos` gives a position at the end of its document.
  const clamped = Math.max(0, Math.min(pos, Math.max(0, sourceLength - 1)));
  const ranges = index.sourceToDom(clamped, clamped + 1);
  const range = ranges?.[0];
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}
