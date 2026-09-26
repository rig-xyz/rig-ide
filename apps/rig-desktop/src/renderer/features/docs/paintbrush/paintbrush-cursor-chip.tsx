import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { WhoIcon } from '@renderer/features/comment-mode/comment-mode-ui';

/**
 * Comment mode's cursor (canvas board 16): the plain native pointer (an
 * I-beam over text), with a small chip trailing it that says who you're
 * talking to — a speech bubble for you, the agent's own logo. Offset
 * down-and-right so it never covers the cursor, `pointer-events: none` so it
 * never takes the click/drag that makes the selection, and shown only while
 * the mode is on and the pointer is over the document (never while the
 * composer is open — the caller's own `active` folds that in).
 *
 * Position updates are rAF-throttled: a raw `pointermove` handler can fire
 * far faster than a frame, and there is nothing to gain from re-rendering
 * more often than the screen can show.
 */

/** Small enough to trail the pointer without competing with the caret. */
const CHIP_SIZE = 18;
export function PaintbrushCursorChip({
  active,
  containerRef,
  who,
}: {
  /** Who comment mode is addressed to: a speech bubble for you, the agent's own logo (canvas board 16: no orb). */
  who: RunnableAgent | null;
  /** Armed AND the composer isn't open — the caller decides both; this only tracks the pointer. */
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const nextRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) {
      setPos(null);
      return;
    }

    const flush = () => {
      rafRef.current = null;
      setPos(nextRef.current);
    };
    const schedule = (next: { x: number; y: number } | null) => {
      nextRef.current = next;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(flush);
    };

    // The chip is a "you can brush here" hint for the document text — over
    // the margin, a card, a button or a field it is just clutter (it was
    // sitting on top of the reply box), so it hides there.
    const handleMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(HIDE_OVER)) {
        schedule(null);
        return;
      }
      schedule({ x: event.clientX, y: event.clientY });
    };
    const handleLeave = () => schedule(null);

    container.addEventListener('pointermove', handleMove);
    container.addEventListener('pointerleave', handleLeave);
    return () => {
      container.removeEventListener('pointermove', handleMove);
      container.removeEventListener('pointerleave', handleLeave);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setPos(null);
    };
  }, [active, containerRef]);

  if (!active || pos === null) return null;

  return createPortal(
    // A solid little disc, so the icon reads over any background, including
    // a white page in the light theme.
    <div
      className="border-border-hairline bg-bg-1 text-text-secondary pointer-events-none fixed z-50 grid place-items-center rounded-full border shadow-soft"
      style={{ left: pos.x + OFFSET, top: pos.y + OFFSET, width: CHIP_SIZE + 4, height: CHIP_SIZE + 4 }}
      data-testid="comment-cursor-chip"
    >
      <WhoIcon who={who} size={12} />
    </div>,
    document.body
  );
}

/** Down-and-right so the chip never sits under (or obscures) the cursor it's tracking. */
const OFFSET = 14;

/** Surfaces the chip must never float over — anything that isn't the document's own text. */
const HIDE_OVER =
  'button, a, input, textarea, select, [role="dialog"], [role="menu"], [data-paintbrush-floating-card], [data-comments-rail]';
