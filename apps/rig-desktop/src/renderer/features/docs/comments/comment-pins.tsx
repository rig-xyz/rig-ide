import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@renderer/lib/utils';
import type { DocCommentsStore } from './comments-store';
import { PIN_SIZE, PIN_STEP, pinSlots } from './margin-layout';

/**
 * Numbered pins in the text's left margin, one per commented passage, beside
 * the first line of its anchor (canvas board 17). The same teardrop as pins
 * on a page; the number matches the thread's card. Grey at rest, accent for
 * the thread you're in, dimmer once resolved. One overlay for both Edit and
 * Preview: positions come from the current surface adapter, so a pin sits at
 * the same place in either mode.
 *
 * Lives in the document's scroll container, in its content coordinates, so
 * scrolling carries the pins with the text for free; only layout changes
 * (content, width, a Preview re-render) need a new measure.
 */

type Place = { top: number; left: number };

function placesEqual(a: Map<string, Place>, b: Map<string, Place>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, place] of a) {
    const other = b.get(key);
    if (!other || other.top !== place.top || other.left !== place.left) return false;
  }
  return true;
}

export const CommentPins = observer(function CommentPins({
  store,
  containerRef,
  showResolved,
}: {
  store: DocCommentsStore;
  containerRef: RefObject<HTMLDivElement | null>;
  showResolved: boolean;
}) {
  const surface = store.surface;
  const threads = store.threads.filter((thread) => thread.index !== null && (showResolved || !thread.resolved));
  const numbers = store.threadNumbers;
  const [places, setPlaces] = useState<Map<string, Place>>(new Map());
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container || !surface.ready()) return;
    const box = container.getBoundingClientRect();
    const columnLeft = surface.columnLeft();
    if (columnLeft === null) return;
    const docLength = surface.docLength();
    const raw: { key: string; top: number }[] = [];
    for (const thread of threadsRef.current) {
      const coords = surface.coordsAtPos(Math.min(thread.index!, docLength));
      if (!coords) continue;
      // Centered on the anchor's first line.
      const top = coords.top - box.top + container.scrollTop + (coords.bottom - coords.top - PIN_SIZE) / 2;
      raw.push({ key: thread.root.id, top: Math.round(top) });
    }
    const slots = pinSlots(raw);
    // Kept inside the panel when the text column sits close to its edge.
    const base = Math.max(4, Math.round(columnLeft - box.left - PIN_SIZE - 6));
    const next = new Map(raw.map((pin) => [pin.key, { top: pin.top, left: base - (slots.get(pin.key) ?? 0) * PIN_STEP }]));
    setPlaces((prev) => (placesEqual(prev, next) ? prev : next));
  }, [containerRef, surface]);

  const threadsKey = threads.map((t) => `${t.root.id}:${t.index}:${t.resolved}`).join(',');
  const content = store.documentContent;
  useLayoutEffect(() => {
    recompute();
    // One more pass once the surface has settled (a Preview re-render, CM6 measuring).
    const raf = requestAnimationFrame(recompute);
    return () => cancelAnimationFrame(raf);
  }, [recompute, threadsKey, content, store.surfaceEpoch]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, recompute]);

  return (
    // Each pin is tagged `data-comment-pin`, which the file view's click-away treats as part of the thread.
    <div className="pointer-events-none absolute inset-0" data-testid="comment-pins">
      {threads.map((thread) => {
        const place = places.get(thread.root.id);
        if (!place) return null;
        const id = thread.root.id;
        const active = store.activeThreadId === id;
        const hovered = store.hoveredThreadId === id;
        return (
          <button
            key={id}
            type="button"
            data-comment-pin
            aria-label={`Comment ${numbers.get(id) ?? ''}${thread.resolved ? ', resolved' : ''}`}
            onClick={() => store.setActiveThread(active ? null : id)}
            onMouseEnter={() => store.setHoveredThread(id)}
            onMouseLeave={() => store.setHoveredThread(null)}
            style={{ top: place.top, left: place.left, width: PIN_SIZE, height: PIN_SIZE }}
            className={cn(
              'pointer-events-auto absolute grid place-items-center rounded-[999px_999px_999px_3px] text-[10px] font-bold shadow-[0_0_0_2px_var(--bg-1)] outline-none transition-[transform,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-accent/60',
              active && !thread.resolved && 'bg-accent text-white',
              active && thread.resolved && 'bg-text-muted text-bg-1',
              !active && !thread.resolved && 'bg-text-muted/80 text-bg-1 hover:bg-text-muted',
              !active && thread.resolved && 'bg-border-strong text-text-muted',
              (active || hovered) && 'scale-110'
            )}
          >
            {numbers.get(id)}
          </button>
        );
      })}
    </div>
  );
});
