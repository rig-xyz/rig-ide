import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CommentSelectionPill,
  SELECTION_PILL_HEIGHT,
  selectionPillWidth,
} from '@renderer/features/comment-mode/comment-mode-ui';
import type { AgentMention, DocCommentsStore } from '../comments/comments-store';
import { isPaintbrushArmed, type PaintbrushArming } from '../paintbrush/paintbrush-gating';
import type { PositionIndex } from './position-index';

/**
 * The Preview-mode counterpart to `comments/comment-selection.tsx`'s
 * `CommentSelectionButton` — same floating "Comment" affordance, sourced
 * from the native DOM Selection instead of CM6's selection events (Preview
 * has no editor to subscribe to).
 *
 * Maps the selection to a SOURCE range via the position index
 * (`rangeToSource`) and opens the composer with that pre-located range —
 * exact by construction, markers and all, even across inline formatting
 * (docs/preview-mode-spec.md "Selection → anchor"). FALLBACK: when the
 * index can't map the selection (an unrendered/unmapped stretch), falls
 * back to the plain selected text — `DocCommentsStore.create`'s existing
 * verbatim-quote search (`buildAnchor`) still finds it as long as it's real
 * text in the document. Comment creation is never blocked either way.
 */
export function PreviewCommentSelectionButton({
  getRoot,
  getIndex,
  content,
  store,
  paintbrush,
}: {
  getRoot: () => HTMLElement | null;
  getIndex: () => PositionIndex | null;
  /** The FULL document content (frontmatter included) — `rangeToSource`'s offsets are shifted into this same coordinate space; see `preview-pane.tsx`. */
  content: string;
  store: DocCommentsStore;
  /** See `comments/comment-selection.tsx`'s `CommentSelectionButton` — same gate, same auto-open behavior, Preview's own selection source. */
  paintbrush?: PaintbrushArming;
}) {
  const [pending, setPending] = useState<{ range: Range; text: string; rect: DOMRect } | null>(
    null
  );
  const armed = isPaintbrushArmed(paintbrush);

  useEffect(() => {
    const handleMouseUp = () => {
      const root = getRoot();
      const selection = window.getSelection();
      if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPending(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const text = selection.toString();
      if (!text.trim() || !root.contains(range.commonAncestorContainer)) {
        setPending(null);
        return;
      }
      if (armed) {
        const index = getIndex();
        const mapped = index ? index.rangeToSource(range) : null;
        if (mapped) store.openComposer(content.slice(mapped.start, mapped.end), mapped, paintbrush!.mention);
        else store.openComposer(text, undefined, paintbrush!.mention);
        selection.removeAllRanges();
        setPending(null);
        return;
      }
      setPending({ range: range.cloneRange(), text, rect: range.getBoundingClientRect() });
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [getRoot, armed, paintbrush, getIndex, content, store]);

  // Any scroll (the shared scroll container included) staled the rect —
  // same dismiss-rather-than-chase rule as the Edit-mode button.
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
      const index = getIndex();
      const mapped = index ? index.rangeToSource(pending.range) : null;
      if (mapped) {
        store.openComposer(content.slice(mapped.start, mapped.end), mapped, mention);
      } else {
        store.openComposer(pending.text, undefined, mention);
      }
      setPending(null);
      window.getSelection()?.removeAllRanges();
    },
    [pending, store, getIndex, content]
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

const GAP = 6;
const EDGE = 8;

function place(rect: DOMRect, width: number): { top: number; left: number } {
  const below = rect.bottom + GAP;
  const fitsBelow = below + SELECTION_PILL_HEIGHT + EDGE <= window.innerHeight;
  return {
    top: fitsBelow ? below : Math.max(EDGE, rect.top - SELECTION_PILL_HEIGHT - GAP),
    left: Math.min(Math.max(rect.left, EDGE), window.innerWidth - width - EDGE),
  };
}
