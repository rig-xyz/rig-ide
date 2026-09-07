import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * The Preview-mode twin of `paintbrush-decorations.ts`'s marks — the softer
 * tint painted over the brushed span while its composer is open, and the
 * streaming pulse while a stroke is in flight, both via the CSS Custom
 * Highlight API, exactly the mechanism `preview/comment-highlights.ts`
 * already uses for comment anchors. Kept as its own independent highlight
 * bucket rather than folded into that module's `CommentMarker` pipeline,
 * for the same zero-regression reason `paintbrush-decorations.ts` stays
 * out of `comment-decorations.ts`.
 *
 * Rebuilt (punch-list finding 1 — "streaming pulse, verified mechanism"):
 * a `::highlight()` pseudo-element cannot itself take an `animation`, but
 * IS a normal inheriting box for a *registered* (`@property`) custom
 * property animated on an ancestor — verified in Chromium. The streaming
 * bucket's background is therefore just `var(--rig-brush-pulse)`; the
 * actual keyframe lives once, globally, in `renderer/index.css`
 * (`.rig-brush-pulsing`, toggled on the shared scroll container by
 * `artifact-view.tsx` while any stroke is streaming) — the CM6 Edit-mode
 * streaming mark (`paintbrush-decorations.ts`) reads the exact same custom
 * property, so both surfaces pulse in lockstep off one keyframe. This
 * module no longer needs its own animation or its own reduced-motion
 * handling — both live with the keyframe, once.
 */

const STYLE_ID = 'rig-paintbrush-preview-highlight-styles';
const RESTING_KEY = 'rig-paintbrush';
const STREAMING_KEY = 'rig-paintbrush-streaming';

const HIGHLIGHT_CSS = `
::highlight(${RESTING_KEY}) {
  background-color: color-mix(in srgb, var(--accent) 20%, transparent);
}
::highlight(${STREAMING_KEY}) {
  background-color: var(--rig-brush-pulse);
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
  /** Replace the painted overlay set — at most one range in practice (the composer's live selection, or the one streaming stroke), split into the resting/streaming highlight buckets by each overlay's own `streaming` flag. */
  paint(overlays: readonly PaintbrushOverlay[]): void;
  dispose(): void;
};

export function createPaintbrushPreviewPainter(
  getIndex: () => PositionIndex | null
): PaintbrushPreviewPainter {
  let restingPainted = false;
  let streamingPainted = false;

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
          if (!ranges) continue;
          (overlay.streaming ? streaming : resting).push(...ranges);
        }
      }

      if (resting.length === 0) {
        if (restingPainted) {
          CSS.highlights.delete(RESTING_KEY);
          restingPainted = false;
        }
      } else {
        ensureStyles();
        CSS.highlights.set(RESTING_KEY, new Highlight(...resting));
        restingPainted = true;
      }

      if (streaming.length === 0) {
        if (streamingPainted) {
          CSS.highlights.delete(STREAMING_KEY);
          streamingPainted = false;
        }
      } else {
        ensureStyles();
        CSS.highlights.set(STREAMING_KEY, new Highlight(...streaming));
        streamingPainted = true;
      }
    },

    dispose() {
      if (!highlightApiSupported()) return;
      CSS.highlights.delete(RESTING_KEY);
      CSS.highlights.delete(STREAMING_KEY);
      restingPainted = false;
      streamingPainted = false;
    },
  };
}
