import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/**
 * The Edit-mode half of the paintbrush overlay (`docs/document-focus-design.md`
 * §2, steps 2 & 4): a soft, rounded tint over the brushed span while its
 * composer is open, a firmer tint while a proposal waits to be applied, and
 * a shimmer while a stroke streams. Registered per doc tab exactly like the comments
 * layer's own `comment-decorations.ts` (`doc-extensions.ts`'s registry
 * pattern), but deliberately its OWN independent extension rather than a
 * new `CommentMarker` variant — the existing comment marker pipeline stays
 * completely untouched, so paintbrush-off zero-regression is structural,
 * not just tested-for.
 *
 * `box-decoration-break: clone` (spec's own ask) makes a span that wraps
 * onto a second line paint as two independently-rounded boxes rather than
 * one box with a jagged mid-line edge.
 */

export type PaintbrushOverlay = {
  from: number;
  to: number;
  streaming: boolean;
  /** A proposal is waiting to be applied against this span — steady accent, no pulse. */
  ready?: boolean;
};

export const setPaintbrushOverlay = StateEffect.define<readonly PaintbrushOverlay[]>();

const overlayField = StateField.define<readonly PaintbrushOverlay[]>({
  create: () => [],
  update(overlays, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPaintbrushOverlay)) return effect.value;
    }
    if (!tr.docChanged || overlays.length === 0) return overlays;
    return overlays
      .map((overlay) => ({
        ...overlay,
        from: tr.changes.mapPos(overlay.from, 1),
        to: tr.changes.mapPos(overlay.to, -1),
      }))
      .filter((overlay) => overlay.to > overlay.from);
  },
});

const RESTING = Decoration.mark({ class: 'cm-paintbrushOverlay' });
/** A stroke is streaming: the resting tint plus a gradient sweep (`renderer/index.css`). */
const STREAMING = Decoration.mark({ class: 'cm-paintbrushOverlay cm-paintbrushStreaming' });
/** A proposal is waiting to be applied: a slightly firmer, steady tint. */
const READY = Decoration.mark({ class: 'cm-paintbrushOverlay cm-paintbrushReady' });

function markFor(overlay: PaintbrushOverlay): Decoration {
  if (overlay.streaming) return STREAMING;
  if (overlay.ready) return READY;
  return RESTING;
}

function overlayDecorations(): Extension {
  return EditorView.decorations.compute([overlayField], (state) => {
    const overlays = state.field(overlayField);
    if (overlays.length === 0) return Decoration.none;
    const docLength = state.doc.length;
    const ranges = overlays
      .filter((overlay) => overlay.from < overlay.to && overlay.to <= docLength)
      .map((overlay) => markFor(overlay).range(overlay.from, overlay.to));
    return Decoration.set(ranges, true);
  });
}

// The paintbrush paints NO tint of its own: the comments layer already
// marks the selected/anchored passage (`comment-decorations.ts`), and a
// second tint on top read as a saturated purple slab. The only paintbrush
// paint is the streaming SWEEP, which lives in `renderer/index.css` as
// `.cm-editor .cm-paintbrushStreaming` (it needs `@keyframes` and a
// reduced-motion `@media` override, both awkward inside a CM6 theme). The
// resting/ready marks stay as class hooks only.
const paintbrushTheme = EditorView.theme({
  '.cm-paintbrushOverlay': {
    borderRadius: '4px',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
});

export function paintbrushDecorations(): Extension {
  return [overlayField, overlayDecorations(), paintbrushTheme];
}
