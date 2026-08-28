import { MessageSquarePlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocCommentsStore } from '../comments/comments-store';
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
}: {
  getRoot: () => HTMLElement | null;
  getIndex: () => PositionIndex | null;
  /** The FULL document content (frontmatter included) — `rangeToSource`'s offsets are shifted into this same coordinate space; see `preview-pane.tsx`. */
  content: string;
  store: DocCommentsStore;
}) {
  const [pending, setPending] = useState<{ range: Range; text: string; rect: DOMRect } | null>(
    null
  );

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
      setPending({ range: range.cloneRange(), text, rect: range.getBoundingClientRect() });
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [getRoot]);

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

  const start = useCallback(() => {
    if (pending === null) return;
    const index = getIndex();
    const mapped = index ? index.rangeToSource(pending.range) : null;
    if (mapped) {
      store.openComposer(content.slice(mapped.start, mapped.end), mapped);
    } else {
      store.openComposer(pending.text);
    }
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }, [pending, store, getIndex, content]);

  if (pending === null) return null;
  const { top, left } = place(pending.rect);

  return createPortal(
    <button
      type="button"
      // Keep the selection: a plain click here would blur it away.
      onMouseDown={(event) => event.preventDefault()}
      onClick={start}
      style={{ top, left, width: BUTTON_WIDTH, height: BUTTON_HEIGHT }}
      className="border-border-hairline bg-bg-1 text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control fixed z-50 flex items-center justify-center gap-1.5 border text-xs shadow-soft"
    >
      <MessageSquarePlus className="size-3.5 shrink-0" />
      Comment
    </button>,
    document.body
  );
}

const BUTTON_WIDTH = 104;
const BUTTON_HEIGHT = 26;
const GAP = 6;
const EDGE = 8;

function place(rect: DOMRect): { top: number; left: number } {
  const below = rect.bottom + GAP;
  const fitsBelow = below + BUTTON_HEIGHT + EDGE <= window.innerHeight;
  return {
    top: fitsBelow ? below : Math.max(EDGE, rect.top - BUTTON_HEIGHT - GAP),
    left: Math.min(Math.max(rect.left, EDGE), window.innerWidth - BUTTON_WIDTH - EDGE),
  };
}
