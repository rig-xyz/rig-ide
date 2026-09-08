import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PositionIndex } from '../preview/position-index';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * The Preview-mode streaming sweep: the same gradient the Edit-mode CM6 mark
 * animates (`renderer/index.css`, `.rig-brush-sweep`), painted on rectangles
 * that trace the streaming span's line boxes. `::highlight()` can't take a
 * gradient, so this is the one paintbrush treatment in Preview that is a
 * real element rather than a highlight.
 *
 * It sits INSIDE the preview root (portaled as a child), so it scrolls with
 * the content and needs no scroll tracking; it's `position: absolute`, so it
 * occupies no layout; and it paints BEHIND the text: the root becomes an
 * isolated stacking context (`.rig-brush-sweep-host`) and the layer takes
 * `z-index: -1`, which puts it above the root's background and below its
 * in-flow content, exactly where a native highlight would be. Rects are
 * re-measured when the root resizes (content reflow) and on window resize,
 * rAF-batched.
 */

type Rect = { left: number; top: number; width: number; height: number };

function measure(root: HTMLElement, index: PositionIndex, overlay: PaintbrushOverlay): Rect[] {
  const ranges = index.sourceToDom(overlay.from, overlay.to);
  if (!ranges) return [];
  const origin = root.getBoundingClientRect();
  const rects: Rect[] = [];
  for (const range of ranges) {
    if (range.toString().trim() === '') continue;
    for (const r of Array.from(range.getClientRects())) {
      if (r.width === 0 || r.height === 0) continue;
      rects.push({
        left: r.left - origin.left,
        top: r.top - origin.top,
        width: r.width,
        height: r.height,
      });
    }
  }
  return rects;
}

export function PaintbrushPreviewSweep({
  active,
  getRoot,
  getIndex,
  overlay,
}: {
  /** Preview is the showing surface (never paint into a hidden root). */
  active: boolean;
  getRoot: () => HTMLElement | null;
  getIndex: () => PositionIndex | null;
  overlay: PaintbrushOverlay | null;
}) {
  const streaming = active && overlay !== null && overlay.streaming;
  const [rects, setRects] = useState<Rect[]>([]);
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = streaming ? getRoot() : null;
    setRoot(el);
    if (!el) {
      setRects([]);
      return;
    }
    el.classList.add('rig-brush-sweep-host');

    let raf: number | null = null;
    const remeasure = () => {
      raf = null;
      const index = getIndex();
      setRects(index && overlay ? measure(el, index, overlay) : []);
    };
    const schedule = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(remeasure);
    };

    remeasure();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf !== null) cancelAnimationFrame(raf);
      el.classList.remove('rig-brush-sweep-host');
    };
    // `overlay` is a fresh object each render; depend on its primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, overlay?.from, overlay?.to, getRoot, getIndex]);

  // Belt and braces for the one case a ResizeObserver can't see: the text
  // reflowing without the root changing size. Cheap while a stroke is live.
  useEffect(() => {
    if (!root) return;
    const tick = setInterval(() => {
      const index = getIndex();
      if (index && overlay) setRects(measure(root, index, overlay));
    }, 500);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, overlay?.from, overlay?.to, getIndex]);

  if (!root || rects.length === 0) return null;

  return createPortal(
    <div aria-hidden className="rig-brush-sweep-layer">
      {rects.map((rect, i) => (
        <div
          key={i}
          className="rig-brush-sweep"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
    </div>,
    root
  );
}
