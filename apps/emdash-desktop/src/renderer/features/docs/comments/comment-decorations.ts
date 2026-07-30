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

const activeMark = Decoration.mark({ class: 'cm-rigComment' });
const resolvedMark = Decoration.mark({ class: 'cm-rigComment cm-rigCommentResolved' });

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
    private readonly onFocusThread: (id: string) => void
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof CommentGlyphWidget &&
      other.threadId === this.threadId &&
      other.resolved === this.resolved
    );
  }

  toDOM(): HTMLElement {
    const glyph = document.createElement('span');
    glyph.className = this.resolved
      ? 'cm-rigCommentGlyph cm-rigCommentGlyphResolved'
      : 'cm-rigCommentGlyph';
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
  const byLineStart = new Map<number, { id: string; resolved: boolean }>();
  for (const marker of markers) {
    if (marker.from > docLength) continue;
    const start = state.doc.lineAt(marker.from).from;
    const seen = byLineStart.get(start);
    if (seen === undefined) {
      byLineStart.set(start, { id: marker.id, resolved: marker.resolved });
    } else if (!marker.resolved) {
      seen.resolved = false;
    }
  }
  return [...byLineStart.entries()].map(([from, { id, resolved }]) => ({
    from,
    widget: new CommentGlyphWidget(id, resolved, onFocusThread),
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
      .map((marker) => (marker.resolved ? resolvedMark : activeMark).range(marker.from, marker.to));
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
  '.cm-rigComment': {
    backgroundColor: 'color-mix(in srgb, var(--blue-9) 10%, transparent)',
    borderBottom: '1px solid color-mix(in srgb, var(--blue-9) 50%, transparent)',
    cursor: 'pointer',
  },
  '.cm-rigCommentResolved': {
    backgroundColor: 'transparent',
    borderBottom: '1px dotted var(--border)',
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
});

// ── extension ────────────────────────────────────────────────────────────────

/**
 * @param onFocusThread called with a thread root id when the reader clicks an
 *   anchored passage or its marker dot.
 */
export function commentDecorations(onFocusThread: (id: string) => void): Extension {
  const markerAt = (view: EditorView, pos: number): CommentMarker | null =>
    view.state.field(markerField).find((marker) => pos >= marker.from && pos <= marker.to) ?? null;

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
