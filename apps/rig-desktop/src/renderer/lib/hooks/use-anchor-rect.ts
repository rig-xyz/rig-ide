import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * The screen rect a portaled dropdown/popover should position itself
 * against — same pattern the comments margin's `@`-mention menu uses
 * (`comments-margin.tsx`, migrated onto this hook so the flip logic below
 * lives in exactly one place), pulled out here so the harness picker and
 * the user-account popover don't each hand-roll it separately.
 *
 * Placement-aware on BOTH axes: vertically, measures the space below vs.
 * above the anchor and picks whichever side actually fits (or fits better),
 * so a trigger near the bottom of the window — the composer's harness
 * picker being the case that exposed this — doesn't open a menu that's
 * clipped off-screen. Horizontally, the same idea decides `align`: a
 * left-aligned menu (growing rightward from the trigger's left edge) flips
 * to right-aligned (growing leftward from the trigger's right edge) when it
 * wouldn't fit — the "Add" menu near the window's right edge being the case
 * that exposed THIS ("Dylan's dogfooding" round). `maxHeight` is a hard
 * safety net on top of the vertical estimate: cap the popup to it (with its
 * own internal scroll) and it can never overflow the viewport even when the
 * caller's `estimatedHeight` guess is wrong. There's no equivalent width
 * safety net — callers size their popup width themselves (fixed, or
 * `Math.max(rect.width, someMin)`), and `estimatedWidth` is that same
 * number fed back in so the align decision matches what will actually
 * render.
 */
export type AnchorRect = {
  left: number;
  /** CSS `top` to use when `placement === 'below'`. */
  top: number;
  /** CSS `bottom` (distance from the viewport's bottom edge) to use when `placement === 'above'`. */
  bottom: number;
  width: number;
  /** Distance from the viewport's right edge — for popovers that should hang right-aligned (e.g. near the window edge) instead of left-aligned. */
  right: number;
  /** Which side had enough room (or the better of two bad options). */
  placement: 'below' | 'above';
  /** Which edge the popup should anchor its OWN horizontal position to: `'left'` → use `left` (grows rightward), `'right'` → use `right` (grows leftward). */
  align: 'left' | 'right';
  /** Available space (px) on the chosen side, minus the gap — cap the popup's own max-height to this. */
  maxHeight: number;
};

type AnchorBox = { top: number; bottom: number; left: number; right: number; width: number };
type Viewport = { width: number; height: number };

/**
 * The pure geometry decision — no DOM, no React — so it's unit-testable on
 * its own (`use-anchor-rect.test.ts`) the way `share-mint-state.ts`'s
 * decision functions are.
 */
export function computeAnchorRect(
  box: AnchorBox,
  viewport: Viewport,
  options: { gap: number; estimatedHeight: number; estimatedWidth: number; align: 'left' | 'right' }
): AnchorRect {
  const { gap, estimatedHeight, estimatedWidth, align: preferredAlign } = options;

  const spaceBelow = viewport.height - box.bottom - gap;
  const spaceAbove = box.top - gap;
  const placement: 'below' | 'above' =
    spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove ? 'below' : 'above';

  // Space available growing rightward from the trigger's left edge (a
  // left-aligned popup) vs. growing leftward from the trigger's right edge
  // (a right-aligned one). Same "prefer the caller's side unless it doesn't
  // fit and the other one is at least as good" rule the vertical flip uses,
  // just applied to whichever side the caller prefers rather than a fixed
  // "below" default (there's no universal reading-direction preference here
  // — a trigger near the window's left edge wants left-align, one near the
  // right edge wants right-align, and callers already know which they are).
  const spaceLeftAlign = viewport.width - box.left - gap;
  const spaceRightAlign = box.right - gap;
  const align: 'left' | 'right' =
    preferredAlign === 'left'
      ? spaceLeftAlign >= estimatedWidth || spaceLeftAlign >= spaceRightAlign
        ? 'left'
        : 'right'
      : spaceRightAlign >= estimatedWidth || spaceRightAlign >= spaceLeftAlign
        ? 'right'
        : 'left';

  return {
    left: box.left,
    top: box.bottom + gap,
    bottom: viewport.height - box.top + gap,
    width: box.width,
    right: viewport.width - box.right,
    placement,
    align,
    maxHeight: Math.max(120, placement === 'below' ? spaceBelow : spaceAbove),
  };
}

export function useAnchorRect(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  options: { gap?: number; estimatedHeight?: number; estimatedWidth?: number; align?: 'left' | 'right' } = {}
): AnchorRect | null {
  const gap = options.gap ?? 4;
  const estimatedHeight = options.estimatedHeight ?? 240;
  const estimatedWidth = options.estimatedWidth ?? 200;
  const align = options.align ?? 'left';
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      setRect(
        computeAnchorRect(
          box,
          { width: window.innerWidth, height: window.innerHeight },
          { gap, estimatedHeight, estimatedWidth, align }
        )
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, gap, estimatedHeight, estimatedWidth, align]);

  return rect;
}
