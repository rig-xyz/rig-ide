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
export const setPaintbrushArmed = StateEffect.define<boolean>();

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

const armedField = StateField.define<boolean>({
  create: () => false,
  update(armed, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPaintbrushArmed)) return effect.value;
    }
    return armed;
  },
});

const RESTING = Decoration.mark({ class: 'cm-paintbrushOverlay' });
// Tailwind's `animate-pulse` is already reduced-motion-gated globally
// (`tokens.css`) — reused here rather than a bespoke keyframe so this one
// gate covers every pulse in the app, this one included.
const STREAMING = Decoration.mark({ class: 'cm-paintbrushOverlay cm-paintbrushStreaming animate-pulse' });

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

/**
 * A small tracked-orb cursor while the mode is armed — cheaper than a
 * pointer-following React element (spec's own call: "pick the cheaper, less
 * janky one"), since it costs the browser nothing per frame. `armedField`
 * drives a class on `.cm-content` via `contentAttributes`, so this needs no
 * imperative DOM writes from the React layer at all.
 */
function cursorAttributes(): Extension {
  return EditorView.contentAttributes.compute([armedField], (state) =>
    state.field(armedField) ? { class: 'cm-paintbrushArmed' } : ({} as Record<string, string>)
  );
}

/**
 * A small tinted orb cursor, shared between Edit (CM6, via the theme below)
 * and Preview (`artifact-view.tsx` sets it directly on the preview root's
 * inline style — Preview has no CM6 theme to hook into). One literal color
 * baked into the data URI, not a CSS var: a `cursor: url(...)` value is
 * resolved once at parse time and cannot reference `var(--accent)`, so this
 * picks a fixed accent-adjacent tone that reads reasonably in both themes
 * rather than one that's exactly on-brand in only one of them.
 */
export const PAINTBRUSH_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Ccircle cx='8' cy='8' r='5.5' fill='%236b6bf0' fill-opacity='0.85' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") 8 8, text`;

const paintbrushTheme = EditorView.theme({
  '.cm-paintbrushOverlay': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)',
    borderRadius: '4px',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
  '.cm-paintbrushStreaming': {
    backgroundColor: 'color-mix(in srgb, var(--text-muted) 30%, transparent)',
  },
  '.cm-paintbrushArmed': {
    cursor: PAINTBRUSH_CURSOR,
  },
});

export function paintbrushDecorations(): Extension {
  return [overlayField, armedField, overlayDecorations(), cursorAttributes(), paintbrushTheme];
}
