import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/**
 * The Edit-mode half of the paintbrush overlay (`docs/document-focus-design.md`
 * §2, steps 2 & 4): a softer, rounder highlight over the brushed span while
 * its composer is open, and an inner mono pulse while an agent stroke is
 * streaming against it. Registered per doc tab exactly like the comments
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

export type PaintbrushOverlay = { from: number; to: number; streaming: boolean };

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
/**
 * The streaming mark (punch-list finding 1 — "streaming pulse, verified
 * mechanism"): its background is `var(--rig-brush-pulse)`, the SAME
 * registered custom property the Preview streaming highlight
 * (`paintbrush-preview-highlight.ts`) reads — animated once, globally, by
 * `.rig-brush-pulsing` in `renderer/index.css`. A plain CM6 mark is an
 * ordinary DOM element, so it repaints on its own as the inherited custom
 * property changes value each keyframe tick; nothing here needs its own
 * `animation` or its own reduced-motion handling any more — both live
 * with the keyframe, once.
 */
const STREAMING = Decoration.mark({ class: 'cm-paintbrushOverlay cm-paintbrushStreaming' });

function overlayDecorations(): Extension {
  return EditorView.decorations.compute([overlayField], (state) => {
    const overlays = state.field(overlayField);
    if (overlays.length === 0) return Decoration.none;
    const docLength = state.doc.length;
    const ranges = overlays
      .filter((overlay) => overlay.from < overlay.to && overlay.to <= docLength)
      .map((overlay) => (overlay.streaming ? STREAMING : RESTING).range(overlay.from, overlay.to));
    return Decoration.set(ranges, true);
  });
}

const paintbrushTheme = EditorView.theme({
  '.cm-paintbrushOverlay': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)',
    borderRadius: '4px',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
  '.cm-paintbrushStreaming': {
    backgroundColor: 'var(--rig-brush-pulse)',
  },
});

export function paintbrushDecorations(): Extension {
  return [overlayField, overlayDecorations(), paintbrushTheme];
}
