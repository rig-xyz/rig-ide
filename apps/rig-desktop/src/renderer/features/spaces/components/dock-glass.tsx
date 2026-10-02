import { useId, type ReactNode } from 'react';

/**
 * The dock's goo. Every shape of the dock (the rail's capsule, each pill, the
 * drop, the peek and its neck) is a plain filled shape in ONE layer that an
 * SVG filter blurs and re-thresholds, so shapes that come within a few pixels
 * of each other melt into one continuous surface. The shadow is on the layer,
 * after the filter, never on a shape. The text, avatars and buttons live in a
 * second layer above, placed on the same boxes (`dock-stage.tsx`).
 *
 * The filter is the one the Room's context pill and the pinned card's chip
 * use, with a harder threshold so pills 6px apart join into a neck.
 */

/** The ring a dock control shows when the keyboard is on it. */
export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60';

/** The spring the shapes move on. */
export const GOO_SPRING = 'cubic-bezier(.25,1.15,.4,1)';
/** A drop falling from the rail into the column: no overshoot. */
export const GOO_DRIP = 'cubic-bezier(.5,0,.25,1)';

/** One liquid fill, whatever the theme: `--pill-fill` is set per light and dark. */
export const GOO_FILL = 'var(--pill-fill)';

/** The filter's definition, and the id to put in `filter: url(#id)`. */
export function useGooFilter(): { id: string; defs: ReactNode } {
  const id = `dock-goo-${useId().replace(/:/g, '')}`;
  const defs = (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <filter
          id={id}
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
  return { id, defs };
}
