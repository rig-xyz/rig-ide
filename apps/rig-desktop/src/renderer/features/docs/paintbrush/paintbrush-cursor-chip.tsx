import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { PaintbrushOrb } from './paintbrush-orb';

/**
 * The v1 data-URI cursor (`paintbrush-decorations.ts`'s old `PAINTBRUSH_CURSOR`)
 * read as a weird, unfamiliar pointer — punch-list finding 3. Removed
 * entirely: the cursor over the document is the plain native one (an
 * I-beam over text, same as ordinary selection), and THIS renders a small
 * orb chip that follows the pointer instead — offset down-and-right so it
 * never sits under the cursor itself, `pointer-events: none` so it can
 * never intercept the click/drag that makes the selection, and shown only
 * while the mode is actually armed and the pointer is over the document
 * surface (never while the composer is open — the caller's own `active`
 * already folds that in, same fade-out the spec asks for).
 *
 * Rebuilt (punch-list finding 3 — "one orb, everywhere"): a plain purple
 * CSS circle read as an unrelated indicator next to the header's own
 * `ThinkingOrb`. This now renders the exact same `PaintbrushOrb` — the
 * `searching` animation, one shared tint — at a small size, so the chip
 * and the header read as one system rather than two.
 *
 * Position updates are rAF-throttled: a raw `pointermove` handler can fire
 * far faster than a frame, and there is nothing to gain from re-rendering
 * more often than the screen can show.
 */

/** Small enough to trail the pointer without competing with the caret; big enough that the orb's animation still reads. */
const CHIP_SIZE = 16;
export function PaintbrushCursorChip({
  active,
  containerRef,
}: {
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

    const handleMove = (event: PointerEvent) => schedule({ x: event.clientX, y: event.clientY });
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
    <div
      className="pointer-events-none fixed z-50"
      style={{ left: pos.x + OFFSET, top: pos.y + OFFSET }}
    >
      <PaintbrushOrb spin="idle" size={CHIP_SIZE} />
    </div>,
    document.body
  );
}

/** Down-and-right so the chip never sits under (or obscures) the cursor it's tracking. */
const OFFSET = 14;
