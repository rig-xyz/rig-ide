import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * The Preview-mode twin of `paintbrush-decorations.ts` — same overlay
 * semantics (a softer tint while the composer is open on the brushed span,
 * an inner mono pulse while its stroke streams), painted over the rendered
 * Preview DOM via the CSS Custom Highlight API, exactly the mechanism
 * `preview/comment-highlights.ts` already uses for comment anchors. Kept as
 * its own independent highlight bucket rather than folded into that
 * module's `CommentMarker` pipeline, for the same zero-regression reason
 * `paintbrush-decorations.ts` stays out of `comment-decorations.ts`.
 */

const STYLE_ID = 'rig-paintbrush-preview-highlight-styles';
const RESTING_KEY = 'rig-paintbrush';
const STREAMING_KEY = 'rig-paintbrush-streaming';

// `::highlight()` supports only a small style subset (no border-radius, no
// box-decoration-break — the rounded-corner ask is Edit-mode only, unreachable
// here). `animation` on a highlight pseudo is inconsistently supported across
// Chromium versions; the static `background-color` is the guaranteed fallback
// either way, so the pulse degrades to "a steadier tint" rather than nothing.
const HIGHLIGHT_CSS = `
::highlight(${RESTING_KEY}) {
  background-color: color-mix(in srgb, var(--accent) 20%, transparent);
}
::highlight(${STREAMING_KEY}) {
  background-color: color-mix(in srgb, var(--text-muted) 30%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  ::highlight(${STREAMING_KEY}) {
    animation: rig-paintbrush-pulse 1.75s ease-in-out infinite;
  }
}
@keyframes rig-paintbrush-pulse {
  0%, 100% { background-color: color-mix(in srgb, var(--text-muted) 18%, transparent); }
  50% { background-color: color-mix(in srgb, var(--text-muted) 42%, transparent); }
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
  /** Replace the painted overlay — at most one range in practice (the composer's live selection, or the one thread currently streaming). */
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
      const streaming: Range[] = [];
      if (index) {
        for (const overlay of overlays) {
          const ranges = index
            .sourceToDom(overlay.from, overlay.to)
            ?.filter((range) => range.toString().trim() !== '');
          if (!ranges || ranges.length === 0) continue;
          (overlay.streaming ? streaming : resting).push(...ranges);
        }
      }

      if (resting.length === 0 && streaming.length === 0) {
        if (painted) {
          CSS.highlights.delete(RESTING_KEY);
          CSS.highlights.delete(STREAMING_KEY);
          painted = false;
        }
        return;
      }

      ensureStyles();
      if (resting.length > 0) CSS.highlights.set(RESTING_KEY, new Highlight(...resting));
      else CSS.highlights.delete(RESTING_KEY);
      if (streaming.length > 0) CSS.highlights.set(STREAMING_KEY, new Highlight(...streaming));
      else CSS.highlights.delete(STREAMING_KEY);
      painted = true;
    },

    dispose() {
      if (!highlightApiSupported()) return;
      CSS.highlights.delete(RESTING_KEY);
      CSS.highlights.delete(STREAMING_KEY);
      painted = false;
    },
  };
}
