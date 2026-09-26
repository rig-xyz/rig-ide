import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { CommentSurfaceAdapter } from './surface-adapter';

/**
 * The in-editor half of the comments layer: a subtle underline over each
 * anchored passage (the numbered pin beside it is `comment-pins.tsx`).
 *
 * This extension is deliberately dumb — it fetches nothing and re-anchors
 * nothing. `DocCommentsStore` computes positions and pushes them in with
 * `setCommentMarkers`; everything here is a projection of that list.
 *
 * Ported from emdash's `comment-decorations.ts`, retextured onto this app's
 * tokens (`--accent`/`--accent-subtle` in place of the old `--blue-9`/`--blue-11`).
 */

export type CommentMarker = {
  /** Thread root id. */
  id: string;
  from: number;
  to: number;
  resolved: boolean;
  /** The thread the reader currently has selected, in the margin or here. */
  active: boolean;
};

/** Replaces the whole marker set. Dispatched by the store after every re-anchor. */
export const setCommentMarkers = StateEffect.define<readonly CommentMarker[]>();

const markerField = StateField.define<readonly CommentMarker[]>({
  create: () => [],
  update(markers, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCommentMarkers)) return effect.value;
    }
    if (!tr.docChanged || markers.length === 0) return markers;
    // The store repaints on every content change, but map positions anyway so
    // the markers are never briefly wrong (or out of document range).
    return markers
      .map((marker) => ({
        ...marker,
        from: tr.changes.mapPos(marker.from, 1),
        to: tr.changes.mapPos(marker.to, -1),
      }))
      .filter((marker) => marker.to > marker.from);
  },
});

/** The four states an anchored passage can be painted in. */
const MARKS = {
  resting: Decoration.mark({ class: 'cm-rigComment' }),
  restingResolved: Decoration.mark({ class: 'cm-rigComment cm-rigCommentResolved' }),
  active: Decoration.mark({ class: 'cm-rigComment cm-rigCommentActive' }),
  activeResolved: Decoration.mark({
    class: 'cm-rigComment cm-rigCommentResolved cm-rigCommentActive',
  }),
};

function markFor(marker: CommentMarker): Decoration {
  if (marker.active) return marker.resolved ? MARKS.activeResolved : MARKS.active;
  return marker.resolved ? MARKS.restingResolved : MARKS.resting;
}

/** Underlines over every anchored passage. The numbered pins beside them are `comment-pins.tsx`, one overlay for Edit and Preview. */
function anchorDecorations(): Extension {
  return EditorView.decorations.compute([markerField], (state) => {
    const markers = state.field(markerField);
    if (markers.length === 0) return Decoration.none;
    const docLength = state.doc.length;
    const ranges = markers
      .filter((marker) => marker.from < marker.to && marker.to <= docLength)
      .map((marker) => markFor(marker).range(marker.from, marker.to));
    // `true` sorts the ranges: markers arrive in reading order but mapping can
    // reorder them, and overlapping anchors are legal.
    return Decoration.set(ranges, true);
  });
}

// ── theme ────────────────────────────────────────────────────────────────────

const commentTheme = EditorView.theme({
  // Resting anchors carry an underline and nothing else. A tint here stacked
  // wherever two anchors overlapped, and two stacked tints read as a third
  // colour rather than as two comments — a hairline can only ever be a hairline.
  // Recognising a comment at rest is the pin's job; telling *which* comment is
  // the selection's, below.
  '.cm-rigComment': {
    borderBottom: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
    cursor: 'pointer',
  },
  '.cm-rigCommentResolved': {
    borderBottom: '1px dotted var(--border-strong)',
  },
  // The selected passage and its card share one accent — `--accent`, the active pin's
  // colour — because that shared colour is the only thing tying the two halves
  // of the selection together.
  //
  // Overlapping marks are rendered by CM6 as nested spans, and which of the two
  // ends up on the outside depends on where each one starts. Both nestings are
  // spelled out so the selection paints solid across its whole range either way
  // instead of half-blending into the anchor it overlaps. Same 1px border as at
  // rest: the document's line height must not move when a thread is selected.
  '.cm-rigCommentActive, .cm-rigCommentActive .cm-rigComment, .cm-rigComment .cm-rigCommentActive':
    {
      backgroundColor: 'var(--accent-subtle)',
      borderBottom: '1px solid var(--accent)',
    },
  // Resolved stays gray even while active (Dylan: "resolved = gray everywhere,
  // active or not") — a strengthened version of the resting resolved look
  // (solid instead of dotted, a faint neutral wash) rather than the accent
  // treatment above, which resolving a thread must never bring back. Three
  // classes deep so this always outranks the rule above: both are otherwise
  // (0,2,0)-specificity selectors on the same element (`markFor` puts all
  // three classes on one mark for an active+resolved thread, never nested),
  // and a tie falls back to source order — too fragile to rely on.
  '.cm-rigComment.cm-rigCommentActive.cm-rigCommentResolved': {
    backgroundColor: 'color-mix(in srgb, var(--text-muted) 16%, transparent)',
    borderBottom: '1px solid var(--border-strong)',
  },
});

// ── extension ────────────────────────────────────────────────────────────────

/**
 * @param onFocusThread called with a thread root id when the reader clicks an
 *   anchored passage. The store makes that thread the active
 *   one; nothing here tracks the selection.
 * @param onHoverThread called with a thread root id, or `null`, as the pointer
 *   enters/leaves an anchored passage — the doc→card half of the stronger
 *   visual coupling Dylan asked for (hovering a passage lifts its card in the
 *   margin even before it's clicked).
 */
export function commentDecorations(
  onFocusThread: (id: string) => void,
  onHoverThread: (id: string | null) => void
): Extension {
  /** The tightest anchor under the pointer, so nesting stays clickable. */
  const markerAt = (view: EditorView, pos: number): CommentMarker | null => {
    let hit: CommentMarker | null = null;
    for (const marker of view.state.field(markerField)) {
      if (pos < marker.from || pos > marker.to) continue;
      if (hit === null || marker.to - marker.from < hit.to - hit.from) hit = marker;
    }
    return hit;
  };

  // Only reported on actual change — `mousemove` fires on every pixel, and
  // the store write (and the margin re-render it triggers) should not.
  let lastHovered: string | null = null;
  const reportHover = (id: string | null): void => {
    if (id === lastHovered) return;
    lastHovered = id;
    onHoverThread(id);
  };

  return [
    markerField,
    anchorDecorations(),
    commentTheme,
    EditorView.domEventHandlers({
      // Non-preventing: the caret still moves, we just also focus the card.
      mouseup(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const hit = markerAt(view, pos);
        if (hit) onFocusThread(hit.id);
        return false;
      },
      mousemove(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const hit = pos !== null ? markerAt(view, pos) : null;
        reportHover(hit?.id ?? null);
        return false;
      },
      mouseleave() {
        reportHover(null);
        return false;
      },
    }),
  ];
}

// ── surface adapter ─────────────────────────────────────────────────────────

/**
 * The CM6 `CommentSurfaceAdapter` (see `surface-adapter.ts`) — Edit mode's
 * side of the seam, a direct wrap of the `EditorView` calls
 * `DocCommentsStore`/`MarginRail` made before the adapter existed. Behavior
 * is unchanged: `paintMarkers` dispatches the same `setCommentMarkers`
 * effect, `coordsAtPos`/`docLength` proxy the same `EditorView` methods.
 */
export function cm6SurfaceAdapter(getView: () => EditorView | null): CommentSurfaceAdapter {
  return {
    ready: () => getView() !== null,
    docLength: () => getView()?.state.doc.length ?? 0,
    coordsAtPos: (pos) => getView()?.coordsAtPos(pos) ?? null,
    columnLeft: () => {
      const content = getView()?.contentDOM;
      if (!content) return null;
      // The text starts inside `.cm-content`'s own padding (doc-editor-theme.ts).
      return content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft || '0');
    },
    paintMarkers: (markers) => {
      const view = getView();
      if (!view) return;
      view.dispatch({ effects: setCommentMarkers.of(markers) });
    },
  };
}
