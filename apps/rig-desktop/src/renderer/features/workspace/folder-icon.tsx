import { useId } from 'react';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §2): the tree's
 * folder glyph, owned rather than vendored raster art — a soft gradient
 * fill driven by this app's own design tokens (`renderer/tokens.css`) so it
 * stays theme-aware (dark/light, and any future accent) with no separate
 * asset per theme, unlike a flat PNG. Fluent Emoji's folder was reviewed as
 * shape reference only, per the design doc; the actual geometry here is the
 * closed/open folder silhouette from `lucide-react` (already a direct,
 * ISC-licensed dependency of this app, and the one every other row icon in
 * the tree already draws from) — filled with a gradient and stroked, not
 * lucide's own stroke-only rendering, which is what makes this a distinct,
 * owned treatment rather than a re-skinned import.
 *
 * Tint variants: `neutral` (the tree's default) and `accent` — reserved for
 * a future emphasis case (e.g. a pinned or actively-syncing folder). Only
 * two variants because `tokens.css` only defines one accent color today; a
 * richer per-category palette would need new tokens proposed there first
 * (its own header comment invites exactly that), not invented ad hoc here.
 */

export type FolderTint = 'neutral' | 'accent';

const CLOSED_PATH =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const OPEN_PATH =
  'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2';

const GRADIENT_STOPS: Record<FolderTint, [string, string]> = {
  neutral: ['var(--bg-2)', 'var(--border-strong)'],
  accent: ['var(--accent-subtle)', 'var(--accent)'],
};

export function FolderIcon({
  open,
  tint = 'neutral',
  className,
}: {
  open: boolean;
  tint?: FolderTint;
  className?: string;
}) {
  const gradientId = `folder-fill-${useId()}`;
  const [from, to] = GRADIENT_STOPS[tint];

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      shapeRendering="geometricPrecision"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: from }} />
          <stop offset="100%" style={{ stopColor: to }} />
        </linearGradient>
      </defs>
      <path
        d={open ? OPEN_PATH : CLOSED_PATH}
        fill={`url(#${gradientId})`}
        stroke="var(--border-strong)"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
