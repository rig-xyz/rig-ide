import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CommentSelectionPill,
  SELECTION_PILL_HEIGHT,
  selectionPillWidth,
} from '@renderer/features/comment-mode/comment-mode-ui';
import type { DocSelectionRect } from '../doc-editor';
import type { DocTabResource } from '../doc-file-sync';
import { isPaintbrushArmed, type PaintbrushArming } from '../paintbrush/paintbrush-gating';
import type { AgentMention, DocCommentsStore } from './comments-store';

/**
 * The "Comment" affordance that floats next to a live text selection, Docs-style:
 * comment mode's selection pill (canvas board 16), with one-click asks for
 * your first agents.
 *
 * Rendered in a portal at fixed position because the rect CM6 hands us is in
 * viewport coordinates. Any scroll invalidates that rect, so we dismiss rather
 * than try to keep up.
 */

const GAP = 6;
const EDGE = 8;

type Pending = { quote: string; rect: DocSelectionRect };

function place(rect: DocSelectionRect, width: number): { top: number; left: number } {
  const below = rect.bottom + GAP;
  const fitsBelow = below + SELECTION_PILL_HEIGHT + EDGE <= window.innerHeight;
  return {
    top: fitsBelow ? below : Math.max(EDGE, rect.top - SELECTION_PILL_HEIGHT - GAP),
    left: Math.min(Math.max(rect.left, EDGE), window.innerWidth - width - EDGE),
  };
}

export function CommentSelectionButton({
  resource,
  store,
  paintbrush,
}: {
  resource: DocTabResource;
  store: DocCommentsStore;
  /**
   * Comment mode (canvas board 16): while it's on, a selection release
   * opens the composer straight away, addressed to `mention` (null for just
   * you), instead of showing the pill.
   */
  paintbrush?: PaintbrushArming;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const armed = isPaintbrushArmed(paintbrush);

  useEffect(
    () =>
      resource.subscribeSelection((selection) => {
        if (selection.text.trim().length === 0 || selection.rect === null) {
          setPending(null);
          return;
        }
        if (armed) {
          // CM6 selections already carry exact source offsets — build the
          // anchor straight from them (`buildAnchorFromRange`, never
          // refuses) rather than falling back to a verbatim-text search.
          store.openComposer(
            selection.text,
            { start: selection.from, end: selection.to },
            paintbrush!.mention
          );
          return;
        }
        setPending({ quote: selection.text, rect: selection.rect });
      }),
    [resource, armed, paintbrush, store]
  );

  // Any scroll (the editor's own scroller included) staled the rect.
  useEffect(() => {
    if (pending === null) return;
    const dismiss = () => setPending(null);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [pending]);

  const start = useCallback(
    (mention: AgentMention | null) => {
      if (pending === null) return;
      store.openComposer(pending.quote, undefined, mention);
      setPending(null);
    },
    [pending, store]
  );

  if (pending === null) return null;
  const agents = paintbrush?.agents ?? [];
  const { top, left } = place(pending.rect, selectionPillWidth(agents));

  return createPortal(
    <CommentSelectionPill
      top={top}
      left={left}
      agents={agents}
      onComment={() => start(null)}
      onAsk={(agent) => start({ providerId: agent.id, name: agent.name })}
    />,
    document.body
  );
}
