import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * Preview-mode tints for the paintbrush, via the CSS Custom Highlight API
 * (the same mechanism `preview/comment-highlights.ts` uses for comment
 * anchors): a soft tint over the brushed span while its composer is open,
 * and a slightly firmer tint on the span a proposal is waiting to be applied
 * to. The streaming SWEEP is not a highlight at all: `::highlight()` takes
 * no gradients, so `paintbrush-preview-sweep.tsx` paints that one as a
 * layer behind the text instead, and streaming overlays are skipped here.
 */

const STYLE_ID = 'rig-paintbrush-preview-highlight-styles';
const RESTING_KEY = 'rig-paintbrush';
const READY_KEY = 'rig-paintbrush-ready';

const RESTING_ALPHA = 16;
const READY_ALPHA = 22;

const HIGHLIGHT_CSS = `
::highlight(${RESTING_KEY}) {
  background-color: color-mix(in srgb, var(--accent) ${RESTING_ALPHA}%, transparent);
}
::highlight(${READY_KEY}) {
  background-color: color-mix(in srgb, var(--accent) ${READY_ALPHA}%, transparent);
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

function setOrClear(key: string, ranges: Range[], painted: Set<string>): void {
  if (ranges.length === 0) {
    if (painted.has(key)) {
      CSS.highlights.delete(key);
      painted.delete(key);
    }
    return;
  }
  ensureStyles();
  CSS.highlights.set(key, new Highlight(...ranges));
  painted.add(key);
}

export type PaintbrushPreviewPainter = {
  /** Replace the painted overlay set: at most one range in practice (the composer's live selection, or the one proposal waiting to be applied). */
  paint(overlays: readonly PaintbrushOverlay[]): void;
  dispose(): void;
};

export function createPaintbrushPreviewPainter(
  getIndex: () => PositionIndex | null
): PaintbrushPreviewPainter {
  const painted = new Set<string>();

  return {
    paint(overlays) {
      if (!highlightApiSupported()) return;
      const index = getIndex();
      const resting: Range[] = [];
      const ready: Range[] = [];
      if (index) {
        for (const overlay of overlays) {
          if (overlay.streaming) continue;
          const ranges = index
            .sourceToDom(overlay.from, overlay.to)
            ?.filter((range) => range.toString().trim() !== '');
          if (!ranges) continue;
          (overlay.ready ? ready : resting).push(...ranges);
        }
      }
      setOrClear(RESTING_KEY, resting, painted);
      setOrClear(READY_KEY, ready, painted);
    },

    dispose() {
      if (!highlightApiSupported()) return;
      CSS.highlights.delete(RESTING_KEY);
      CSS.highlights.delete(READY_KEY);
      painted.clear();
    },
  };
}
