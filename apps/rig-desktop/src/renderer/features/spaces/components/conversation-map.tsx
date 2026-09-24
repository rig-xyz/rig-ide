import { ListTree } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * The Room's outline, tucked into its top-left corner. At rest it's a small
 * minimap: one hairline per row, agent turns in the accent, a thin frame for
 * what's on screen. Hover or focus opens it into a readable list (who, and
 * the first words), the rows in view marked; clicking one jumps to it.
 * Hidden while the whole conversation fits on screen.
 */

export type MapEntry = {
  id: string;
  /** Agent turns stand out; your own messages are dimmer than others'. */
  tone: 'agent' | 'person' | 'mine' | 'other';
  label: string;
  preview: () => string;
};

type Placed = { id: string; top: number };

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
        <button
          type="button"
          aria-label="Outline"
          className="border-border-hairline bg-bg-1/80 hover:border-border-strong relative block h-20 w-5 rounded-control border transition-colors"
        >
          <span
            className="border-accent/50 absolute inset-x-0.5 rounded-sm border"
            style={{ top: `${view.top * 100}%`, height: `max(6px, ${view.height * 100}%)` }}
          />
          {placed.map(({ id, top }) => {
            const entry = byId.get(id);
            if (!entry) return null;
            return (
              <span
                key={id}
                className={cn(
                  'absolute right-1 block h-px rounded-full',
                  entry.tone === 'agent' ? 'bg-accent left-1' : 'left-2',
                  entry.tone === 'person' && 'bg-text-muted',
                  entry.tone === 'mine' && 'bg-text-muted/60',
                  entry.tone === 'other' && 'bg-border-strong'
                )}
                style={{ top: `${top * 100}%` }}
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
                    <span className="truncate text-2xs text-text-muted">{entry.label}</span>
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
