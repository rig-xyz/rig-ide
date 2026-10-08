import { ListTree } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * The Room's outline, tucked into its top-left corner. At rest it's a short
 * stack of dashes, one per row (agent turns a little longer), the ones on
 * screen brighter, as in Claude's own chat. Hover or focus opens it into a
 * readable list (who, and the first words), the rows in view marked;
 * clicking one jumps to it.
 * Hidden while the whole conversation fits on screen.
 *
 * A light trail: while a face in the dock is hovered or spotlit, that
 * person's or agent's rows show in the accent.
 */

export type MapEntry = {
  id: string;
  /** Agent turns stand out; your own messages are dimmer than others'. */
  tone: 'agent' | 'person' | 'mine' | 'other';
  label: string;
  preview: () => string;
  /** On the trail of the face the dock is showing. */
  lit?: boolean;
};

type Placed = { id: string; top: number };

const MAX_DASHES = 24;

/** Up to `max` items, evenly spread across the list (always keeping the last). */
function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]!);
}

export function ConversationMap({
  scrollRef,
  contentRef,
  entries,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  entries: MapEntry[];
  onJump: (id: string) => void;
}) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [view, setView] = useState({ top: 0, height: 1 });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const measure = () => {
      const total = scroller.scrollHeight || 1;
      setView({ top: scroller.scrollTop / total, height: Math.min(1, scroller.clientHeight / total) });
      const next: Placed[] = [];
      for (const entry of entries) {
        const el = content.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(entry.id)}"]`);
        if (el) next.push({ id: entry.id, top: el.offsetTop / total });
      }
      setPlaced(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', measure);
    };
  }, [scrollRef, contentRef, entries]);

  // Nothing to navigate when everything already fits.
  if (view.height >= 0.66 || placed.length < 6) return null;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const inView = (top: number) => top >= view.top - 0.01 && top <= view.top + view.height;

  return (
    <div
      className="absolute top-3 left-3 z-10"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      data-testid="conversation-map"
    >
      {!open ? (
        // At rest: a short stack of dashes, one per row (evenly sampled past
        // a couple dozen), the ones on screen brighter. No frame, no scale.
        <button type="button" aria-label="Outline" className="flex flex-col items-start gap-[5px] p-1.5">
          {sample(placed, MAX_DASHES).map(({ id, top }) => {
            const entry = byId.get(id);
            if (!entry) return null;
            const visible = inView(top);
            return (
              <span
                key={id}
                className={cn(
                  'block h-0.5 rounded-full transition-[width,background-color] duration-150',
                  entry.tone === 'agent' ? 'w-4' : 'w-2.5',
                  entry.lit
                    ? visible
                      ? 'bg-accent'
                      : 'bg-accent/60'
                    : visible
                      ? 'bg-text-primary'
                      : 'bg-text-muted/45'
                )}
                data-lit={entry.lit ? 'true' : undefined}
              />
            );
          })}
        </button>
      ) : (
        <div className="popover-in border-border-hairline bg-bg-1 shadow-float flex max-h-[min(420px,60vh)] w-72 flex-col overflow-hidden rounded-card border">
          <div className="border-border-hairline flex h-8 shrink-0 items-center gap-1.5 border-b px-3 text-xs text-text-muted">
            <ListTree className="size-3.5" strokeWidth={1.5} />
            Outline
          </div>
          <div className="min-h-0 overflow-y-auto p-1" role="list">
            {placed.map(({ id, top }) => {
              const entry = byId.get(id);
              if (!entry) return null;
              return (
                <button
                  key={id}
                  type="button"
                  role="listitem"
                  onClick={() => onJump(id)}
                  className={cn(
                    'hover:bg-bg-2 flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left transition-colors',
                    inView(top) && 'bg-bg-2/60'
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      entry.tone === 'agent' ? 'bg-accent' : 'bg-text-muted/60'
                    )}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={cn('truncate text-2xs', entry.lit ? 'text-accent' : 'text-text-muted')}
                      data-lit={entry.lit ? 'true' : undefined}
                    >
                      {entry.label}
                    </span>
                    <span className="line-clamp-1 text-xs text-text-secondary">{entry.preview() || '…'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
