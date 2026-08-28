import type { CommentMarker } from './comment-decorations';

/**
 * The seam between `DocCommentsStore`/`MarginRail` and whatever surface is
 * currently rendering the document — docs/preview-mode-spec.md "Margin
 * rail": "Introduce a small surface adapter interface — the comments store
 * currently attaches to the CM6 editor; the preview provides the same
 * contract from the DOM index instead."
 *
 * Two implementations, both satisfying this same interface:
 *   - `comment-decorations.ts`'s `cm6SurfaceAdapter` — Edit mode, unchanged
 *     behavior (a straight wrap of the existing `EditorView` calls).
 *   - `features/docs/preview/preview-surface-adapter.ts`'s
 *     `previewSurfaceAdapter` — Preview mode, backed by the position index
 *     and the CSS Custom Highlight API painter.
 *
 * `DocCommentsStore` holds exactly one at a time (CM6 by default,
 * `setSurfaceAdapter` swaps it while Preview is showing) and never imports
 * CM6 or the position index itself; `MarginRail` reads positions through it
 * instead of an `EditorView` directly.
 */

export type SurfaceRect = { top: number; bottom: number; left: number; right: number };

export interface CommentSurfaceAdapter {
  /**
   * Whether the surface is currently mounted/renderable — an `EditorView`
   * exists, or the preview's position index has been built at least once.
   * `false` short-circuits marker painting and margin positioning exactly
   * as the pre-adapter code did when `editorRef.current?.getView()` was
   * null.
   */
  ready(): boolean;
  /** Total addressable length of the underlying text (CM6 doc length / the full document content length). */
  docLength(): number;
  /** Viewport-relative rect of a document offset, or null when it can't be measured. */
  coordsAtPos(pos: number): SurfaceRect | null;
  /** Paint (or clear) the current marker set on this surface. */
  paintMarkers(markers: readonly CommentMarker[]): void;
}
