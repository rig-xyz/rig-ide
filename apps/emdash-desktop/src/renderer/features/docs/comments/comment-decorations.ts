import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

/**
 * The in-editor half of the comments layer: a subtle underline over each
 * anchored passage plus a dot beside the line the passage starts on.
 *
 * This extension is deliberately dumb — it fetches nothing and re-anchors
 * nothing. `DocCommentsStore` computes positions and pushes them in with
 * `setCommentMarkers`; everything here is a projection of that list.
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

// ── marker dot ───────────────────────────────────────────────────────────────

/**
 * The dot beside a commented line.
 *
 * It lives in the content flow (an inline widget at the line start) rather than
 * in a gutter, so it tracks the centered writing column instead of the far left
 * edge of the scroller. The theme takes it out of flow with `position: absolute`
 * inside the relatively-positioned `.cm-line`, which is what keeps it from
 * adding any width or height to the line — no spacer needed.
 */
class CommentGlyphWidget extends WidgetType {
  constructor(
    private readonly threadId: string,
    private readonly resolved: boolean,
    private readonly active: boolean,
    private readonly onFocusThread: (id: string) => void
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof CommentGlyphWidget &&
      other.threadId === this.threadId &&
      other.resolved === this.resolved &&
      other.active === this.active
    );
  }

  toDOM(): HTMLElement {
    const glyph = document.createElement('span');
    glyph.className = [
      'cm-rigCommentGlyph',
      this.resolved ? 'cm-rigCommentGlyphResolved' : '',
      this.active ? 'cm-rigCommentGlyphActive' : '',
    ]
      .filter(Boolean)
      .join(' ');
    glyph.title = this.resolved ? 'Resolved comment' : 'Comment';
    glyph.addEventListener('mousedown', (event) => {
      // Focus the card without moving the caret into the widget.
      event.preventDefault();
      this.onFocusThread(this.threadId);
    });
    return glyph;
  }

  /** The editor should not treat clicks on the dot as content interaction. */
  ignoreEvent(): boolean {
    return true;
  }
}

/** One dot per line that holds at least one anchor; unresolved wins. */
function glyphsForLines(
  state: EditorState,
  onFocusThread: (id: string) => void
): { from: number; widget: CommentGlyphWidget }[] {
  const markers = state.field(markerField);
  const docLength = state.doc.length;
  // First marker on a line owns the click target; the dot only reads as
  // resolved when every anchor starting on that line is resolved.
  const byLineStart = new Map<number, { id: string; resolved: boolean; active: boolean }>();
  for (const marker of markers) {
    if (marker.from > docLength) continue;
    const start = state.doc.lineAt(marker.from).from;
    const seen = byLineStart.get(start);
    if (seen === undefined) {
      byLineStart.set(start, { id: marker.id, resolved: marker.resolved, active: marker.active });
      continue;
    }
    if (!marker.resolved) seen.resolved = false;
    // The selected thread takes its line's dot over: where two anchors share a
    // line, the dot must not point away from the thread the reader is reading.
    if (marker.active) {
      seen.id = marker.id;
      seen.active = true;
    }
  }
  return [...byLineStart.entries()].map(([from, { id, resolved, active }]) => ({
    from,
    widget: new CommentGlyphWidget(id, resolved, active, onFocusThread),
  }));
}

/** Underlines over every anchored passage plus a dot on each line they start. */
function anchorDecorations(onFocusThread: (id: string) => void): Extension {
  return EditorView.decorations.compute([markerField], (state) => {
    const markers = state.field(markerField);
    if (markers.length === 0) return Decoration.none;
    const docLength = state.doc.length;
    const ranges = markers
      .filter((marker) => marker.from < marker.to && marker.to <= docLength)
      .map((marker) => markFor(marker).range(marker.from, marker.to));
    for (const { from, widget } of glyphsForLines(state, onFocusThread)) {
      // `side: -1` puts the dot before anything else at the line start, so it
      // never ends up nested inside an underline span.
      ranges.push(Decoration.widget({ widget, side: -1 }).range(from));
    }
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
  // Recognising a comment at rest is the dot's job; telling *which* comment is
  // the selection's, below.
  '.cm-rigComment': {
    borderBottom: '1px solid color-mix(in srgb, var(--blue-9) 45%, transparent)',
    cursor: 'pointer',
  },
  '.cm-rigCommentResolved': {
    borderBottom: '1px dotted var(--border)',
  },
  // The selected passage and its card share one accent — `--blue-11`, the dot's
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
      backgroundColor: 'color-mix(in srgb, var(--blue-9) 22%, transparent)',
      borderBottom: '1px solid var(--blue-11)',
    },
  // Out of flow, so the dot costs the line no width and no height. `left` keeps
  // it inside `.cm-content`'s 24px left padding — immediately beside the text,
  // scrolling and re-centering with the writing column. Vertically centered on
  // the line's first row: half of the 1.7 line-height, less half the dot.
  '.cm-rigCommentGlyph': {
    position: 'absolute',
    left: '-18px',
    top: 'calc(0.85em - 3px)',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: 'var(--blue-11)',
    cursor: 'pointer',
  },
  '.cm-rigCommentGlyphResolved': {
    backgroundColor: 'var(--foreground-passive)',
  },
  // A halo rather than a bigger dot: `box-shadow` paints outside the box without
  // changing it, so the selected marker cannot nudge the writing column.
  '.cm-rigCommentGlyphActive': {
    backgroundColor: 'var(--blue-11)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--blue-9) 28%, transparent)',
  },
});

// ── extension ────────────────────────────────────────────────────────────────

/**
 * @param onFocusThread called with a thread root id when the reader clicks an
 *   anchored passage or its marker dot. The store makes that thread the active
 *   one; nothing here tracks the selection.
 */
export function commentDecorations(onFocusThread: (id: string) => void): Extension {
  /** The tightest anchor under the pointer, so nesting stays clickable. */
  const markerAt = (view: EditorView, pos: number): CommentMarker | null => {
    let hit: CommentMarker | null = null;
    for (const marker of view.state.field(markerField)) {
      if (pos < marker.from || pos > marker.to) continue;
      if (hit === null || marker.to - marker.from < hit.to - hit.from) hit = marker;
    }
    return hit;
  };

  return [
    markerField,
    anchorDecorations(onFocusThread),
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
    }),
  ];
}
