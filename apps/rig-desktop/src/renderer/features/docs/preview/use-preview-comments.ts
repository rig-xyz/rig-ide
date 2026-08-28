import { useLayoutEffect, useRef } from 'react';
import type { DocCommentsStore } from '../comments/comments-store';
import { createPreviewCommentPainter } from './comment-highlights';
import type { PositionIndex } from './position-index';
import { previewSurfaceAdapter } from './preview-surface-adapter';

/**
 * Wires the Preview pane into the comments layer
 * (docs/preview-mode-spec.md "Anchor → highlight" + "Margin rail"):
 * registers a `CommentSurfaceAdapter` on the store while Preview is showing
 * (restoring the CM6 default via `setSurfaceAdapter(null)` on cleanup),
 * paints open threads' anchors with the CSS Custom Highlight API
 * (`comment-highlights.ts`), and hit-tests clicks/hover against the painted
 * ranges to drive `store.setActiveThread`/`setHoveredThread` — the same
 * cross-surface contract Edit mode gets from `comment-decorations.ts`'s CM6
 * event handlers.
 *
 * `active` gates every side effect: false while Edit mode is showing (or
 * comments are hidden/disabled), so this never fights CM6 for the store's
 * surface.
 *
 * Deliberately lives OUTSIDE `PreviewPane` (composed here, by whatever calls
 * this hook — `artifact-view.tsx`) so the pane itself stays usable with no
 * comments store at all, per docs/preview-mode-spec.md's "Keep PreviewPane
 * usable without comments" note.
 */
export function usePreviewComments({
  active,
  getRoot,
  getIndex,
  sourceLength,
  store,
}: {
  active: boolean;
  getRoot: () => HTMLElement | null;
  getIndex: () => PositionIndex | null;
  /** The FULL document content length (frontmatter included) — matches the coordinate space `store.threads`' anchors are computed in. */
  sourceLength: number;
  store: DocCommentsStore | null;
}): void {
  const painterRef = useRef<ReturnType<typeof createPreviewCommentPainter> | null>(null);
  if (painterRef.current === null) painterRef.current = createPreviewCommentPainter(getIndex);
  const painter = painterRef.current;

  // The adapter outlives any single render (the registration effect below
  // deliberately doesn't re-run on content changes), so it must read the
  // CURRENT length through a ref — `() => sourceLength` would freeze the
  // value from the registering render, which on a cold open is 0 (content
  // still loading), clamping every anchor position to 0 forever and leaving
  // the margin permanently unmeasured.
  const sourceLengthRef = useRef(sourceLength);
  sourceLengthRef.current = sourceLength;

  // Register/unregister the surface adapter as Preview mode is entered/left.
  // A fresh `useLayoutEffect` run (not `useEffect`) so the very first paint
  // after registering lands before the browser paints the frame — same
  // reasoning as the repaint-trigger effect below.
  useLayoutEffect(() => {
    if (!active || !store) return;
    store.setSurfaceAdapter(
      previewSurfaceAdapter(getIndex, () => sourceLengthRef.current, painter)
    );
    return () => {
      store.setSurfaceAdapter(null);
      painter.dispose();
    };
    // getIndex/painter are stable for this hook's lifetime; re-running is
    // driven by `active`/`store` (a mode switch) — `sourceLength` changes
    // are handled by the repaint effect below without tearing this down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store]);

  // Repaint whenever the content actually changed. `DocCommentsStore`'s own
  // mobx reaction on `resource.content` re-anchors and repaints
  // synchronously, BEFORE React has re-rendered `PreviewPane` with the new
  // content (let alone rebuilt its position index) — so that first paint can
  // land against a stale index. This effect corrects it: as a
  // `useLayoutEffect`, it runs after `PreviewPane`'s own index-rebuild
  // effect (child effects fire before parent effects) but still before the
  // browser paints the frame, so the correction is invisible rather than a
  // flash (docs/preview-mode-spec.md rollout step 3(b): "agent edit arriving
  // mid-read re-anchors highlights without a flash").
  useLayoutEffect(() => {
    if (!active || !store) return;
    store.syncMarkers();
  }, [active, store, sourceLength]);

  // Cold-open settle correction: the position index becomes ready (and the
  // surface-adapter registration effect above bumps `surfaceEpoch`) as soon
  // as `PreviewPane`'s own layout effect has run — but that can land before
  // fonts (or KaTeX's stylesheet, or an `<img>`) have actually finished
  // loading, so `coordsAtPos` measures a pre-settle rect and the margin
  // never gets a chance to correct itself. Unlike CM6, which reflows
  // continuously off its own editor events, nothing else re-triggers a
  // Preview margin re-layout once mounted — so this asks for one
  // explicitly: once fonts genuinely settle, and again on every
  // preview-root size change (an image finishing, KaTeX reflowing).
  // Debounced via rAF so a burst of those in the same frame collapses into
  // one repaint request.
  useLayoutEffect(() => {
    const root = getRoot();
    if (!active || !store || !root) return;

    let raf = 0;
    const relayout = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        store.requestSurfaceRelayout();
      });
    };

    void document.fonts.ready.then(relayout);
    const ro = new ResizeObserver(relayout);
    ro.observe(root);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active, store, getRoot]);

  // Click/hover hit-testing against the painted ranges.
  useLayoutEffect(() => {
    const root = getRoot();
    if (!active || !store || !root) return;

    let hoverRaf = 0;
    const handleClick = (event: MouseEvent) => {
      const selection = window.getSelection();
      // A live selection is the reader making a new comment, not clicking an
      // existing one — don't fight `PreviewCommentSelectionButton`.
      if (selection && !selection.isCollapsed) return;
      store.setActiveThread(painter.hitTest(event.clientX, event.clientY));
    };
    const handleMouseMove = (event: MouseEvent) => {
      const { clientX, clientY } = event;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const id = painter.hitTest(clientX, clientY);
        root.style.cursor = id ? 'pointer' : '';
        store.setHoveredThread(id);
      });
    };
    const handleMouseLeave = () => {
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
      root.style.cursor = '';
      store.setHoveredThread(null);
    };

    root.addEventListener('click', handleClick);
    root.addEventListener('mousemove', handleMouseMove);
    root.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      root.removeEventListener('click', handleClick);
      root.removeEventListener('mousemove', handleMouseMove);
      root.removeEventListener('mouseleave', handleMouseLeave);
    };
    // painter is stable for this hook's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store, getRoot]);
}
