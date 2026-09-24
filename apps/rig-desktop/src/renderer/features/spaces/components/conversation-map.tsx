import { type RefObject, useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * A slim rail beside the Room's transcript: one tick per row, placed where the
 * row sits in the conversation, with agent turns longer and in the accent,
 * and a band showing what's on screen. Hovering a tick previews the row;
 * clicking jumps to it. Only shown once the Room is long enough to need it.
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
  const [hover, setHover] = useState<{ entry: MapEntry; top: number } | null>(null);

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

  return (
    <div
      // Just outside the transcript's centered 44rem column, not at the
      // window edge where the space panel floats.
      className="absolute top-6 bottom-6 z-10 w-4"
      style={{ right: 'max(0.375rem, calc(50% - 22rem - 1.75rem))' }}
      onMouseLeave={() => setHover(null)}
      data-testid="conversation-map"
    >
      <div
        className="bg-bg-3/60 absolute right-0 left-0 rounded-full transition-[top] duration-75"
        style={{ top: `${view.top * 100}%`, height: `${view.height * 100}%` }}
      />
      {placed.map(({ id, top }) => {
        const entry = byId.get(id);
        if (!entry) return null;
        return (
          <button
            key={id}
            type="button"
            aria-label={`Jump to ${entry.label}`}
            onMouseEnter={() => setHover({ entry, top })}
            onFocus={() => setHover({ entry, top })}
            onClick={() => onJump(id)}
            className="absolute right-0 flex h-2 w-full -translate-y-1/2 items-center justify-end"
            style={{ top: `${top * 100}%` }}
          >
            <span
              className={cn(
                'block rounded-full transition-[width,background-color] duration-150',
                entry.tone === 'agent' ? 'bg-accent h-[3px] w-3.5' : 'h-0.5 w-2',
                entry.tone === 'person' && 'bg-text-muted',
                entry.tone === 'mine' && 'bg-text-muted/60',
                entry.tone === 'other' && 'bg-border-strong',
                hover?.entry.id === id && 'w-4'
              )}
            />
          </button>
        );
      })}
      {hover && (
        <div
          className="popover-in border-border-hairline bg-bg-1 shadow-float pointer-events-none absolute right-6 w-64 -translate-y-1/2 rounded-card border px-3 py-2"
          style={{ top: `${hover.top * 100}%` }}
        >
          <p className="text-2xs text-text-muted">{hover.entry.label}</p>
          <p className="line-clamp-2 text-xs text-text-primary">{hover.entry.preview() || '…'}</p>
        </div>
      )}
    </div>
  );
}
