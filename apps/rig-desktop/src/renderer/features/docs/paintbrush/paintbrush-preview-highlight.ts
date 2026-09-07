import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * The Preview-mode twin of `paintbrush-decorations.ts`'s RESTING mark —
 * the softer tint painted over the brushed span while its composer is
 * open, via the CSS Custom Highlight API, exactly the mechanism
 * `preview/comment-highlights.ts` already uses for comment anchors. Kept
 * as its own independent highlight bucket rather than folded into that
 * module's `CommentMarker` pipeline, for the same zero-regression reason
 * `paintbrush-decorations.ts` stays out of `comment-decorations.ts`.
 *
 * STREAMING is deliberately NOT handled here any more (punch-list finding
 * 2a): `::highlight()` pseudo-elements cannot animate reliably across
 * Chromium versions, so a stroke's "inner mono pulse" while it streams
 * degraded to, at best, a static tint here — invisible motion is not a
 * pulse. `paintbrush-preview-streaming-overlay.tsx` now owns that instead,
 * as real positioned DOM elements over the rendered rects
 * (`index.sourceToDom` → `Range.getClientRects()`), which CAN animate.
 * This module keeps the cheap, correct, non-animated Custom Highlight for
 * exactly what it's good at: the RESTING tint while a composer is simply
 * open on a selection, nothing streaming.
 */

const STYLE_ID = 'rig-paintbrush-preview-highlight-styles';
const RESTING_KEY = 'rig-paintbrush';

const HIGHLIGHT_CSS = `
::highlight(${RESTING_KEY}) {
  background-color: color-mix(in srgb, var(--accent) 20%, transparent);
}
`;

function highlightApiSupported(): boolean {
  return typeof window !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;
}

function ensureStyles(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== HIGHLIGHT_CSS) style.textContent = HIGHLIGHT_CSS;
}

export type PaintbrushPreviewPainter = {
  /** Replace the painted RESTING overlay — at most one range in practice (the composer's live selection). Never called with a streaming overlay; the caller filters that out. */
  paint(overlays: readonly PaintbrushOverlay[]): void;
  dispose(): void;
};

export function createPaintbrushPreviewPainter(
  getIndex: () => PositionIndex | null
): PaintbrushPreviewPainter {
  let painted = false;

  return {
    paint(overlays) {
      if (!highlightApiSupported()) return;
      const index = getIndex();
      const resting: Range[] = [];
      if (index) {
        for (const overlay of overlays) {
          if (overlay.streaming) continue; // Handled by the streaming overlay component instead.
          const ranges = index
            .sourceToDom(overlay.from, overlay.to)
            ?.filter((range) => range.toString().trim() !== '');
          if (ranges) resting.push(...ranges);
        }
      }

      if (resting.length === 0) {
        if (painted) {
          CSS.highlights.delete(RESTING_KEY);
          painted = false;
        }
        return;
      }

      ensureStyles();
      CSS.highlights.set(RESTING_KEY, new Highlight(...resting));
      painted = true;
    },

    dispose() {
      if (!highlightApiSupported()) return;
      CSS.highlights.delete(RESTING_KEY);
      painted = false;
    },
  };
}
