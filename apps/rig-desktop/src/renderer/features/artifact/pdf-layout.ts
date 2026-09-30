/**
 * The PDF viewer's arithmetic (`pdf-artifact.tsx`), kept pure so it's
 * tested without pdf.js or a DOM.
 */

/** Zoom levels, relative to "fit width" (1). */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** A page never grows past this at "fit width", however wide the panel: a portrait page as wide as a monitor reads badly. */
export const MAX_FIT_WIDTH = 960;

/** The next zoom step in or out from `zoom` (which may sit between steps); stays put at either end. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0)
    return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOM_STEPS[0];
}

/** A page's CSS width: the panel's width (less its padding), capped, times the zoom; never below a legible minimum. */
export function pageWidthFor(available: number, zoom: number): number {
  const fit = Math.min(Math.max(available, 0), MAX_FIT_WIDTH);
  return Math.max(120, Math.round(fit * zoom));
}

/**
 * The page being read: the last one whose top is above the first third of
 * the view (`tops` are each page's offset in the scroller, in order).
 * 1-based; 1 for an empty list.
 */
export function currentPageAt(
  tops: readonly number[],
  scrollTop: number,
  viewportHeight: number
): number {
  const line = scrollTop + viewportHeight / 3;
  let page = 1;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i]! <= line) page = i + 1;
    else break;
  }
  return page;
}
