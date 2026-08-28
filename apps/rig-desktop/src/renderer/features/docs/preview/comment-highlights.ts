import type { CommentMarker } from '../comments/comment-decorations';
import type { PositionIndex } from './position-index';

/**
 * Paints open comment threads' anchors over the rendered Preview DOM via the
 * CSS Custom Highlight API — no DOM mutation, survives React re-renders
 * (docs/preview-mode-spec.md "Anchor → highlight"). The MECHANISM is ported
 * from hub/web's `useCommentHighlights`, not its locate logic: the position
 * index already gives exact source ranges, so there's no whole-document
 * fuzzy re-locate to do here — every marker this receives
 * (`comments-store.ts`'s `_paintMarkers`, via `preview-surface-adapter.ts`)
 * already carries the real source offset `anchors.ts`'s quote-locate ladder
 * found (the same computation Edit mode's CM6 decorations paint from).
 *
 * Visual states mirror `comment-decorations.ts`'s CM6 marks exactly (resting
 * / resting-resolved / active / active-resolved) using the same app tokens.
 * `::highlight()` supports no `border`, so the underline treatment becomes
 * `text-decoration` instead of CM6's `border-bottom`. There is no separate
 * hover wash: CM6 doesn't paint one either — hovering an anchor only lifts
 * the margin card via `store.setHoveredThread` (see `use-preview-comments.ts`).
 */

/**
 * Checked fresh on every call rather than cached at module load: this
 * module's own tests install `window`/`CSS` after import (vitest's `node`
 * project has no DOM globals at all — see `comment-highlights.test.ts`), and
 * a module-level constant would freeze at `false` forever regardless. No
 * behavior change in the app itself — the Electron renderer always has
 * these globals present before this module ever runs.
 */
function highlightApiSupported(): boolean {
  return typeof window !== 'undefined' && typeof CSS !== 'undefined' && 'highlights' in CSS;
}

const STYLE_ID = 'rig-preview-comment-highlight-styles';
// `text-decoration-skip-ink`/`-thickness` aren't a color or a background,
// just what keeps the line itself reading as one system with CM6's marks:
// CM6's `border-bottom` (`comment-decorations.ts`'s `commentTheme`) is a
// single unbroken 1px hairline; a plain `text-decoration: underline` skips
// around descenders (g/y/j/p/q) by default and can render at a
// browser-chosen thickness — both invisible on their own but exactly what
// reads as "a different, rougher system" once the browser's own native
// selection paints over the same span mid-comment-creation.
// Resting states are underline-only, like CM6's marks — a background wash
// inside `::highlight()` paints a box that hugs the glyphs exactly (the
// API allows no padding/offset/radius), which reads cramped next to Edit
// mode's airy border-bottom (user feedback). The underline is therefore
// the load-bearing signal and must be VISIBLE: 2px at 65% accent, vs
// CM6's 1px/45% border — the highlight-pseudo underline renders lighter
// than a border-bottom, so it needs the extra weight to read at the same
// strength. `text-underline-offset` IS honored in highlight pseudos
// (verified empirically in this Chromium): 0.2em drops the line below the
// glyphs toward where CM6's border-bottom sits. The wash appears only on the
// ACTIVE states, where CM6 paints the same tight inline background
// (`--accent-subtle`), so the snug box matches across surfaces there.
const HIGHLIGHT_CSS = `
::highlight(rig-preview-comment) {
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 65%, transparent);
  text-decoration-thickness: 2px;
  text-decoration-skip-ink: none;
  text-underline-offset: 0.2em;
}
::highlight(rig-preview-comment-resolved) {
  text-decoration: underline dotted;
  text-decoration-color: var(--border-strong);
  text-decoration-thickness: 2px;
  text-decoration-skip-ink: none;
  text-underline-offset: 0.2em;
}
::highlight(rig-preview-comment-active) {
  background-color: var(--accent-subtle);
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-decoration-thickness: 1px;
  text-decoration-skip-ink: none;
  text-underline-offset: 0.2em;
}
::highlight(rig-preview-comment-active-resolved) {
  background-color: color-mix(in srgb, var(--text-muted) 16%, transparent);
  text-decoration: underline dotted;
  text-decoration-color: var(--border-strong);
  text-decoration-thickness: 1px;
  text-decoration-skip-ink: none;
  text-underline-offset: 0.2em;
}
`;

/** Always overwrite, same reasoning as hub/web's own `ensureHighlightStyles`: hot reload must replace stale rules, not keep an earlier injected set. */
function ensureHighlightStyles(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== HIGHLIGHT_CSS) style.textContent = HIGHLIGHT_CSS;
}

function bucketFor(marker: CommentMarker): string {
  if (marker.active) {
    return marker.resolved ? 'rig-preview-comment-active-resolved' : 'rig-preview-comment-active';
  }
  return marker.resolved ? 'rig-preview-comment-resolved' : 'rig-preview-comment';
}

export type PreviewCommentPainter = {
  /**
   * Replace the painted marker set — called on every store re-anchor/
   * active-thread change via the preview `CommentSurfaceAdapter`. A marker
   * whose source range the index can't map (an orphan, or simply not yet
   * indexed) is silently skipped — margin-only, exactly like Edit mode.
   */
  paint(markers: readonly CommentMarker[]): void;
  /** Hit-test a viewport point against the currently painted ranges; returns the thread id under the point, or null. */
  hitTest(clientX: number, clientY: number): string | null;
  /** Clears every registered highlight. Call on unmount / mode switch. */
  dispose(): void;
};

export function createPreviewCommentPainter(
  getIndex: () => PositionIndex | null
): PreviewCommentPainter {
  let rangesById = new Map<string, Range[]>();
  let paintedKeys = new Set<string>();

  return {
    paint(markers) {
      if (!highlightApiSupported()) return;
      const index = getIndex();
      const nextRanges = new Map<string, Range[]>();
      const buckets = new Map<string, Range[]>();
      if (index) {
        for (const marker of markers) {
          // A multi-line anchor's segments include react-markdown's own
          // pretty-printing newline text nodes between block elements —
          // real mappings (a cross-item selection passes through them), but
          // painting a whitespace-only collapsed node draws a stray mark
          // between list items. Highlight only segments with visible text.
          const ranges = index
            .sourceToDom(marker.from, marker.to)
            ?.filter((range) => range.toString().trim() !== '');
          if (!ranges || ranges.length === 0) continue;
          nextRanges.set(marker.id, ranges);
          const key = bucketFor(marker);
          const bucket = buckets.get(key) ?? [];
          bucket.push(...ranges);
          buckets.set(key, bucket);
        }
      }
      rangesById = nextRanges;

      for (const key of paintedKeys) CSS.highlights.delete(key);
      const nextKeys = new Set<string>();
      if (buckets.size > 0) ensureHighlightStyles();
      for (const [key, ranges] of buckets) {
        CSS.highlights.set(key, new Highlight(...ranges));
        nextKeys.add(key);
      }
      paintedKeys = nextKeys;
    },

    hitTest(clientX, clientY) {
      if (!highlightApiSupported() || rangesById.size === 0) return null;
      // Electron's renderer is always Chromium — `caretRangeFromPoint` is
      // always available, unlike hub/web's cross-browser fallback chain.
      const r =
        typeof document.caretRangeFromPoint === 'function'
          ? document.caretRangeFromPoint(clientX, clientY)
          : null;
      if (!r) return null;
      const { startContainer: node, startOffset: offset } = r;
      for (const [id, ranges] of rangesById) {
        for (const range of ranges) {
          try {
            if (range.isPointInRange(node, offset)) return id;
          } catch {
            // Point not comparable against this range (different subtree).
          }
        }
      }
      return null;
    },

    dispose() {
      for (const key of paintedKeys) CSS.highlights.delete(key);
      paintedKeys = new Set();
      rangesById = new Map();
    },
  };
}
