import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@renderer/lib/utils';
import type { DocCommentsStore } from './comments-store';
import { PIN_SIZE, PIN_STEP, pinLines } from './margin-layout';
import { firstTextRect } from './surface-adapter';

/**
 * Numbered pins in the text's left margin, one per commented passage, beside
 * the first line of its anchor (canvas board 17). The same teardrop as pins
 * on a page; the number matches the thread's card. Grey at rest, accent for
 * the thread you're in, dimmer once resolved. One overlay for both Edit and
 * Preview: positions come from the current surface adapter, so a pin sits at
 * the same place in either mode.
 *
 * A thread whose passage can't be found any more (edited away) gets a
 * dashed pin at the top of the text column, so it can still be opened.
 *
 * Threads on the same line share one spot as a stack: the thread you're in
 * (else the lowest number) on top, the others peeking out behind it. Hovering
 * the stack, or tabbing into it, fans it out down the margin so each one can
 * be picked.
 *
 * Lives in the document's scroll container, in its content coordinates, so
 * scrolling carries the pins with the text for free; only layout changes
 * (content, width, a Preview re-render) need a new measure.
 */

type Line = { top: number; left: number; keys: string[] };

function linesEqual(a: Line[], b: Line[]): boolean {
  return (
    a.length === b.length &&
    a.every((line, i) => line.top === b[i].top && line.left === b[i].left && line.keys.join() === b[i].keys.join())
  );
}

/** How much of each pin behind the top one peeks out of a stack, and how many show at all. */
const PEEK = 3;
const PEEK_MAX = 2;

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
  const threads = store.threads.filter((thread) => showResolved || !thread.resolved);
  const numbers = store.threadNumbers;
  const [lines, setLines] = useState<Line[]>([]);
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
      // Lost its passage: pinned at the start of the document instead.
      const coords = thread.index === null ? firstTextRect(surface) : surface.coordsAtPos(Math.min(thread.index, docLength));
      if (!coords) continue;
      // Centered on the anchor's first line.
      const top = coords.top - box.top + container.scrollTop + (coords.bottom - coords.top - PIN_SIZE) / 2;
      raw.push({ key: thread.root.id, top: Math.round(top) });
    }
    // Kept inside the panel when the text column sits close to its edge.
    const left = Math.max(4, Math.round(columnLeft - box.left - PIN_SIZE - 6));
    const next = pinLines(raw).map((line) => ({ ...line, left }));
    setLines((prev) => (linesEqual(prev, next) ? prev : next));
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

  const byId = new Map(threads.map((thread) => [thread.root.id, thread]));
  return (
    // Each pin is tagged `data-comment-pin`, which the file view's click-away treats as part of the thread.
    <div className="pointer-events-none absolute inset-0" data-testid="comment-pins">
      {lines.map((line) => {
        const stack = line.keys
          .flatMap((key) => byId.get(key) ?? [])
          .sort((a, b) => (numbers.get(a.root.id) ?? 0) - (numbers.get(b.root.id) ?? 0));
        if (stack.length === 0) return null;
        const top = stack.find((thread) => thread.root.id === store.activeThreadId) ?? stack[0];
        const pins = [top, ...stack.filter((thread) => thread !== top)];
        const fans = pins.length > 1;
        return (
          <div
            key={line.keys[0]}
            data-testid="comment-pin-stack"
            // Grows to the fanned-out height on hover so the pointer can travel down it.
            style={{ top: line.top, left: line.left, '--fan': `${(pins.length - 1) * PIN_STEP + PIN_SIZE}px` } as React.CSSProperties}
            className={cn(
              'group/stack pointer-events-auto absolute size-5',
              fans && 'hover:z-10 hover:h-(--fan) has-[:focus-visible]:z-10 has-[:focus-visible]:h-(--fan)'
            )}
          >
            {pins.map((thread, i) => {
              const id = thread.root.id;
              const active = store.activeThreadId === id;
              const hovered = store.hoveredThreadId === id;
              const lost = thread.index === null;
              return (
                <button
                  key={id}
                  type="button"
                  data-comment-pin
                  aria-label={`Comment ${numbers.get(id) ?? ''}${thread.resolved ? ', resolved' : ''}${lost ? (thread.ambiguous ? ', its passage appears more than once' : ', its passage is gone') : ''}`}
                  title={lost ? (thread.ambiguous ? `The text this comment was on now appears ${thread.ambiguous} times` : 'The text this comment was on has changed') : undefined}
                  onClick={() => store.setActiveThread(active ? null : id)}
                  onMouseEnter={() => store.setHoveredThread(id)}
                  onMouseLeave={() => store.setHoveredThread(null)}
                  style={
                    {
                      zIndex: pins.length - i,
                      width: PIN_SIZE,
                      height: PIN_SIZE,
                      '--peek': `${-Math.min(i, PEEK_MAX) * PEEK}px`,
                      '--fan-y': `${i * PIN_STEP}px`,
                    } as React.CSSProperties
                  }
                  className={cn(
                    'absolute top-0 left-0 grid place-items-center rounded-[999px_999px_999px_3px] text-[10px] font-bold shadow-[0_0_0_2px_var(--bg-1)] outline-none transition-[translate,scale,background-color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-accent/60',
                    i > 0 &&
                      'translate-y-(--peek) group-hover/stack:translate-y-(--fan-y) group-has-[:focus-visible]/stack:translate-y-(--fan-y)',
                    i > PEEK_MAX && 'opacity-0 group-hover/stack:opacity-100 group-has-[:focus-visible]/stack:opacity-100',
                    active && !thread.resolved && 'bg-accent text-white',
                    active && thread.resolved && 'bg-text-muted text-bg-1',
                    lost && !active && 'border-text-muted text-text-muted border border-dashed bg-bg-1',
                    !lost && !active && !thread.resolved && 'bg-text-muted/80 text-bg-1 hover:bg-text-muted',
                    !lost && !active && thread.resolved && 'bg-border-strong text-text-muted',
                    (active || hovered) && 'scale-110'
                  )}
                >
                  {numbers.get(id)}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});
