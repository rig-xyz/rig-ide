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
 * The RESTING tint only — CM6's own streaming visual now lives entirely in
 * `cm-paintbrushStreaming`'s CSS below (an inset-shadow "inner mono pulse"
 * keyframe, not Tailwind's plain opacity `animate-pulse`): a bare
 * `animate-pulse` on a mark with no background of its own doesn't read at
 * all (finding 2b of the paintbrush v1 punch list — nothing to fade
 * between), so the streaming mark now carries its OWN background/inset
 * glow for the animation to act on.
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
});

// The streaming mark's own animated background/inset glow — kept as a
// plain injected stylesheet rather than folded into `paintbrushTheme`
// above: CM6's `EditorView.theme` (via `style-mod`) has no clean way to
// declare a top-level `@keyframes` block, and the Preview-mode twin of
// this decoration (`paintbrush-preview-highlight.ts`) already injects its
// own styles the same way — same mechanism, same "inner mono pulse" feel,
// on both surfaces.
const STREAMING_STYLE_ID = 'rig-paintbrush-cm-streaming-styles';
const STREAMING_CSS = `
.cm-paintbrushStreaming {
  background-color: color-mix(in srgb, var(--text-muted) 22%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-muted) 30%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .cm-paintbrushStreaming {
    animation: rig-paintbrush-cm-pulse 1.75s ease-in-out infinite;
  }
}
@keyframes rig-paintbrush-cm-pulse {
  0%, 100% {
    background-color: color-mix(in srgb, var(--text-muted) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-muted) 22%, transparent);
  }
  50% {
    background-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
    box-shadow: inset 0 0 6px 1px color-mix(in srgb, var(--text-muted) 55%, transparent);
  }
}
`;

function ensureStreamingStyles(): void {
  if (typeof document === 'undefined') return;
  let style = document.getElementById(STREAMING_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STREAMING_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== STREAMING_CSS) style.textContent = STREAMING_CSS;
}

export function paintbrushDecorations(): Extension {
  ensureStreamingStyles();
  return [overlayField, overlayDecorations(), paintbrushTheme];
}
