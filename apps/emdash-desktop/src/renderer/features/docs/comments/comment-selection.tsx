import { MessageSquarePlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocSelectionRect } from '../doc-editor';
import type { DocTabResource } from '../doc-file-sync';
import type { DocCommentsStore } from './comments-store';

/**
 * The "Comment" affordance that floats next to a live text selection, Docs-style.
 *
 * Rendered in a portal at fixed position because the rect CM6 hands us is in
 * viewport coordinates. Any scroll invalidates that rect, so we dismiss rather
 * than try to keep up.
 */

const BUTTON_WIDTH = 104;
const BUTTON_HEIGHT = 26;
const GAP = 6;
const EDGE = 8;

type Pending = { quote: string; rect: DocSelectionRect };

function place(rect: DocSelectionRect): { top: number; left: number } {
  const below = rect.bottom + GAP;
  const fitsBelow = below + BUTTON_HEIGHT + EDGE <= window.innerHeight;
  return {
    top: fitsBelow ? below : Math.max(EDGE, rect.top - BUTTON_HEIGHT - GAP),
    left: Math.min(Math.max(rect.left, EDGE), window.innerWidth - BUTTON_WIDTH - EDGE),
  };
}

export function CommentSelectionButton({
  resource,
  store,
}: {
  resource: DocTabResource;
  store: DocCommentsStore;
}) {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(
    () =>
      resource.subscribeSelection((selection) => {
        if (selection.text.trim().length === 0 || selection.rect === null) {
          setPending(null);
          return;
        }
        setPending({ quote: selection.text, rect: selection.rect });
      }),
    [resource]
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

  const start = useCallback(() => {
    if (pending === null) return;
    store.openComposer(pending.quote);
    setPending(null);
  }, [pending, store]);

  if (pending === null) return null;
  const { top, left } = place(pending.rect);

  return createPortal(
    <button
      type="button"
      // Keep the editor's selection: a plain click here would blur it away.
      onMouseDown={(event) => event.preventDefault()}
      onClick={start}
      style={{ top, left, width: BUTTON_WIDTH, height: BUTTON_HEIGHT }}
      className="fixed z-50 flex items-center justify-center gap-1.5 rounded-md border border-border bg-background text-xs text-foreground-muted shadow-sm hover:bg-background-1 hover:text-foreground"
    >
      <MessageSquarePlus className="size-3.5 shrink-0" />
      Comment
    </button>,
    document.body
  );
}
