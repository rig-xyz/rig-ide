import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { SourceLogo } from './bits';
import type { Cell, Topic } from './connectors-model';

/**
 * A new item being classified, shown as it happens: it surfaces as a chip by
 * the connector that brought it ("Sorting…"), resolves to its topic and how
 * sure the sorting was, then shrinks into a square of its topic's color and
 * drops into its place in today's grid, where it pulses and its topic's pill
 * bumps. Items that arrive together go one after another.
 */

export interface Flight {
  cell: Cell;
  delay: number;
}

/** Between items of one check, and the chip's beats: surface, read, sorted, then the drop. */
const STAGGER_MS = 650;
const BEATS = { sorted: 850, drop: 1650, dropMs: 650 } as const;

/** Flights for the cells that arrive while the grid is on screen; reduced motion lets them simply appear. */
export function useClassifyFlights(cells: readonly Cell[], reduced: boolean) {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(cells.map((c) => c.id));
  const [flights, setFlights] = useState<Flight[]>([]);

  useEffect(() => {
    const known = seen.current!;
    const fresh = cells.filter((c) => !known.has(c.id));
    for (const c of fresh) known.add(c.id);
    if (reduced || fresh.length === 0) return;
    setFlights((current) => [
      ...current,
      ...fresh.map((cell, i) => ({ cell, delay: i * STAGGER_MS })),
    ]);
  }, [cells, reduced]);

  const land = useCallback(
    (id: string) => setFlights((current) => current.filter((f) => f.cell.id !== id)),
    []
  );
  return { flights, flying: new Set(flights.map((f) => f.cell.id)), land };
}

export function ClassifyFlights({
  flights,
  topics,
  onLand,
}: {
  flights: readonly Flight[];
  topics: readonly Topic[];
  onLand: (id: string) => void;
}) {
  return createPortal(
    <>
      {flights.map((f) => (
        <ClassifyFlight
          key={f.cell.id}
          flight={f}
          topic={topics.find((t) => t.id === f.cell.topic)}
          onLand={onLand}
        />
      ))}
    </>,
    document.body
  );
}

type Phase = 'waiting' | 'reading' | 'sorted' | 'dropping';

function ClassifyFlight({
  flight,
  topic,
  onLand,
}: {
  flight: Flight;
  topic: Topic | undefined;
  onLand: (id: string) => void;
}) {
  const { cell, delay } = flight;
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [start, setStart] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const row = document.querySelector<HTMLElement>(`[data-connector-row="${cell.connector}"]`);
    const target = document.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.id)}"]`);
    if (!row || !target) {
      onLand(cell.id);
      return;
    }
    const r = row.getBoundingClientRect();
    setStart({ left: r.left + 34, top: r.top + r.height / 2 - 14 });
    const timers = [
      setTimeout(() => setPhase('reading'), delay),
      setTimeout(() => setPhase('sorted'), delay + BEATS.sorted),
      setTimeout(() => setPhase('dropping'), delay + BEATS.drop),
    ];
    return () => timers.forEach(clearTimeout);
    // One flight, one run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (phase === 'reading') {
      ref.current?.animate(
        [
          { opacity: 0, transform: 'translateY(6px) scale(.94)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
    if (phase !== 'dropping') return;
    const el = ref.current;
    const target = document.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.id)}"]`);
    if (!el || !target) {
      onLand(cell.id);
      return;
    }
    const a = el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const anim = el.animate(
      [
        {
          transform: 'translate(0, 0)',
          width: `${a.width}px`,
          height: `${a.height}px`,
          borderRadius: '14px',
        },
        {
          transform: `translate(${(b.left - a.left) * 0.55}px, ${(b.top - a.top) * 0.4 - 18}px)`,
          width: `${Math.max(b.width, 28)}px`,
          height: `${Math.max(b.height, 14)}px`,
          borderRadius: '7px',
          offset: 0.5,
        },
        {
          transform: `translate(${b.left - a.left}px, ${b.top - a.top}px)`,
          width: `${b.width}px`,
          height: `${b.height}px`,
          borderRadius: '3px',
        },
      ],
      { duration: BEATS.dropMs, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      onLand(cell.id);
      document
        .querySelector<HTMLElement>(`[data-topic-pill="${CSS.escape(cell.topic)}"]`)
        ?.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }],
          {
            duration: 420,
            easing: 'cubic-bezier(.3,1.5,.5,1)',
          }
        );
    };
    return () => {
      anim.onfinish = null;
    };
    // The drop runs once, when its beat comes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (!start || phase === 'waiting') return null;
  return (
    <div
      ref={ref}
      aria-hidden
      data-phase={phase}
      style={
        {
          left: start.left,
          top: start.top,
          '--hue': `var(--theme-${topic?.hue ?? 4})`,
        } as CSSProperties
      }
      className="hf-classify pointer-events-none fixed z-[60] flex h-7 max-w-[340px] items-center gap-2 overflow-hidden rounded-full border border-border-hairline bg-bg-1 px-2.5 text-xs whitespace-nowrap shadow-float"
    >
      <span className={cn('hf-classify-body flex min-w-0 items-center gap-2')}>
        <SourceLogo connector={cell.connector} size={14} />
        <span className="font-mono text-2xs text-text-secondary">{cell.ref}</span>
        {phase === 'reading' ? (
          <>
            <span className="max-w-[150px] truncate text-text-primary">{cell.title}</span>
            <DotMatrix state="thinking" size="sm" />
            <span className="text-text-muted">Sorting…</span>
          </>
        ) : (
          <>
            <span className="text-text-muted">→</span>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: 'var(--hue)' }}
            />
            <span className="font-medium text-text-primary">{topic?.name}</span>
            {cell.newTopic ? (
              <span className="font-mono text-2xs tracking-wide text-accent uppercase">
                new topic
              </span>
            ) : (
              cell.score !== undefined && (
                <span className="font-mono text-2xs text-text-muted tabular-nums">
                  {cell.score.toFixed(2)}
                </span>
              )
            )}
          </>
        )}
      </span>
    </div>
  );
}
