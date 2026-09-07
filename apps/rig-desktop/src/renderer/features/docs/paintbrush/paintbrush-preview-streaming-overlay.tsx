import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * Preview mode's streaming visual for an in-flight paintbrush stroke
 * (punch-list finding 2a) — a real, animatable overlay LAYER, not the CSS
 * Custom Highlight API `paintbrush-preview-highlight.ts` still uses for
 * the (non-animated) resting tint. `::highlight()` pseudo-elements cannot
 * reliably animate, so the old approach degraded to a static tint exactly
 * when the design asks for the opposite — a visible "something is
 * happening" pulse.
 *
 * Mechanism: `index.sourceToDom(overlay.from, overlay.to)` → DOM
 * `Range[]` → `range.getClientRects()` per range → one absolutely
 * (`fixed`) positioned, `pointer-events: none` div per rendered rect,
 * portaled to `document.body` (same pattern `PaintbrushCursorChip` and the
 * floating "Comment" buttons already use for viewport-coordinate
 * overlays — no positioned ancestor container needed since `getClientRects`
 * is already viewport-relative). Repositioned on scroll/resize/content
 * change, rAF-batched so a burst of DOM mutations only recomputes once
 * per frame.
 */

const STYLE_ID = 'rig-paintbrush-streaming-overlay-styles';
const STREAMING_CSS = `
.rig-paintbrush-streaming-rect {
  background-color: color-mix(in srgb, var(--text-muted) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-muted) 22%, transparent);
  border-radius: 3px;
}
@media (prefers-reduced-motion: no-preference) {
  .rig-paintbrush-streaming-rect {
    animation: rig-paintbrush-streaming-pulse 1.75s ease-in-out infinite;
  }
}
@keyframes rig-paintbrush-streaming-pulse {
  0%, 100% {
    background-color: color-mix(in srgb, var(--text-muted) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-muted) 20%, transparent);
  }
  50% {
    background-color: color-mix(in srgb, var(--text-muted) 38%, transparent);
    box-shadow: inset 0 0 6px 1px color-mix(in srgb, var(--text-muted) 50%, transparent);
  }
}
`;

function ensureStreamingStyles(): void {
  if (typeof document === 'undefined') return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== STREAMING_CSS) style.textContent = STREAMING_CSS;
}

export function PaintbrushStreamingOverlay({
  active,
  getRoot,
  getIndex,
  overlay,
}: {
  /** Preview mode is showing and comments are wired up — same gate every Preview paintbrush hook uses. */
  active: boolean;
  getRoot: () => HTMLElement | null;
  getIndex: () => PositionIndex | null;
  overlay: PaintbrushOverlay | null;
}) {
  const [rects, setRects] = useState<readonly DOMRect[]>([]);
  const rafRef = useRef<number | null>(null);
  const streaming = active && overlay !== null && overlay.streaming;
  const from = overlay?.from;
  const to = overlay?.to;

  useEffect(() => {
    ensureStreamingStyles();
  }, []);

  useEffect(() => {
    if (!streaming || from === undefined || to === undefined) {
      setRects([]);
      return;
    }

    const recompute = (): void => {
      rafRef.current = null;
      const index = getIndex();
      const domRanges = index ? index.sourceToDom(from, to) : null;
      if (!domRanges) {
        setRects([]);
        return;
      }
      const next: DOMRect[] = [];
      for (const range of domRanges) {
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 && rect.height > 0) next.push(rect);
        }
      }
      setRects(next);
    };

    const schedule = (): void => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(recompute);
    };

    recompute();

    // Capture-phase: the shared doc/margin scroll container's own scroll
    // doesn't bubble to `window` (same reason `MentionTextarea`'s mention
    // menu repositions this way).
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);

    const root = getRoot();
    const resizeObserver = root ? new ResizeObserver(schedule) : null;
    if (root && resizeObserver) resizeObserver.observe(root);
    // A content change (the streaming reply's own re-render settling, an
    // agent-absorbed edit landing) can reshape the rendered DOM without
    // the root's own box size changing at all — a plain ResizeObserver
    // would miss that.
    const mutationObserver = root ? new MutationObserver(schedule) : null;
    if (root && mutationObserver) {
      mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
    }

    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [streaming, from, to, getIndex, getRoot]);

  if (!streaming || rects.length === 0) return null;

  return createPortal(
    <>
      {rects.map((rect, index) => (
        <div
          // Rects are recomputed wholesale every pass (not diffed/keyed by
          // identity) — index is a stable enough key for a same-frame list
          // that never reorders meaningfully between renders.
          key={index}
          aria-hidden
          className="rig-paintbrush-streaming-rect pointer-events-none fixed z-40"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
    </>,
    document.body
  );
}
