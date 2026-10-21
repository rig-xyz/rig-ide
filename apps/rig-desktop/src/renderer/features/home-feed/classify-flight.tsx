import { AnimatePresence, motion } from 'motion/react';
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
 * New items being classified, shown as it happens. They wait in a queue under
 * the connectors list ("ULY-521 … Sorting…"), one after another; each resolves
 * to its topic and how sure the sorting was; then it leaves the queue and joins
 * its topic's pill, which bumps, while its square pops into today's grid. A
 * topic the item starts appears as the item joins it.
 */

export type FlightPhase = 'waiting' | 'reading' | 'sorted' | 'joining' | 'landed';

export interface Flight {
  cell: Cell;
  phase: FlightPhase;
  /** Where its queue line was when it left: the join starts there. */
  from?: { left: number; top: number; width: number; height: number };
}

/** Between items of one check, and each item's beats: sorting, sorted, then the join. */
const STAGGER_MS = 900;
const BEATS = { sorted: 900, join: 1800, joinMs: 700, tailMs: 700 } as const;

/** Flights for the cells that arrive while the grid is on screen; reduced motion lets them simply appear. */
export function useClassifyFlights(cells: readonly Cell[], reduced: boolean) {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(cells.map((c) => c.id));
  const [flights, setFlights] = useState<Flight[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((ms: number, run: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      run();
    }, ms);
    timers.current.add(t);
  }, []);

  const setPhase = useCallback((id: string, phase: FlightPhase) => {
    setFlights((current) =>
      current.map((f) => {
        if (f.cell.id !== id) return f;
        if (phase !== 'joining') return { ...f, phase };
        // The line is still in the queue: the join starts where it is.
        const line = document.querySelector<HTMLElement>(
          `[data-classify-line="${CSS.escape(id)}"]`
        );
        const r = line?.getBoundingClientRect();
        return {
          ...f,
          phase,
          from: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : undefined,
        };
      })
    );
  }, []);

  useEffect(() => {
    const known = seen.current!;
    const fresh = cells.filter((c) => !known.has(c.id));
    for (const c of fresh) known.add(c.id);
    if (reduced || fresh.length === 0) return;
    setFlights((current) => [
      ...current,
      ...fresh.map((cell) => ({ cell, phase: 'waiting' as const })),
    ]);
    fresh.forEach((cell, i) => {
      const start = i * STAGGER_MS;
      later(start, () => setPhase(cell.id, 'reading'));
      later(start + BEATS.sorted, () => setPhase(cell.id, 'sorted'));
      later(start + BEATS.join, () => setPhase(cell.id, 'joining'));
    });
  }, [cells, reduced, later, setPhase]);

  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
    };
  }, []);

  /** It reached its pill; its square keeps pulsing a moment, then the flight is done. */
  const land = useCallback(
    (id: string) => {
      setPhase(id, 'landed');
      later(BEATS.tailMs, () => setFlights((current) => current.filter((f) => f.cell.id !== id)));
    },
    [later, setPhase]
  );

  const queued = (f: Flight) =>
    f.phase === 'waiting' || f.phase === 'reading' || f.phase === 'sorted';
  return {
    flights,
    /** Squares not in the grid yet. */
    hidden: new Set(flights.filter(queued).map((f) => f.cell.id)),
    /** Squares popping in right now. */
    popping: new Set(flights.filter((f) => !queued(f)).map((f) => f.cell.id)),
    /** Topics an item in flight starts: their pill appears when it joins. */
    unborn: new Set(
      flights.filter((f) => f.cell.newTopic && f.phase !== 'landed').map((f) => f.cell.topic)
    ),
    land,
  };
}

/** The queue under the connectors list: one line per item being classified. */
export function ClassifyQueue({
  flights,
  topics,
}: {
  flights: readonly Flight[];
  topics: readonly Topic[];
}) {
  const queue = flights.filter(
    (f) => f.phase === 'waiting' || f.phase === 'reading' || f.phase === 'sorted'
  );
  return (
    <div aria-live="polite" className="grid">
      <AnimatePresence initial={false}>
        {queue.map((f) => (
          <motion.div
            key={f.cell.id}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
            className="min-w-0 overflow-hidden"
          >
            <QueueLine flight={f} topic={topics.find((t) => t.id === f.cell.topic)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function QueueLine({ flight, topic }: { flight: Flight; topic: Topic | undefined }) {
  const { cell, phase } = flight;
  return (
    <div
      data-classify-line={cell.id}
      style={{ '--hue': `var(--theme-${topic?.hue ?? 4})` } as CSSProperties}
      className={cn(
        'mt-1.5 flex h-7 min-w-0 items-center gap-2 rounded-full bg-bg-2/70 pr-2.5 pl-1.5 text-xs whitespace-nowrap transition-opacity',
        phase === 'waiting' && 'opacity-60'
      )}
    >
      <SourceLogo connector={cell.connector} size={16} />
      <span className="shrink-0 font-mono text-2xs text-text-secondary">{cell.ref}</span>
      <span className="min-w-0 flex-1 truncate text-text-primary">{cell.title}</span>
      {phase === 'waiting' && <span className="shrink-0 text-text-muted">Queued</span>}
      {phase === 'reading' && (
        <span className="flex shrink-0 items-center gap-1.5 text-text-muted">
          <DotMatrix state="thinking" size="sm" />
          Sorting…
        </span>
      )}
      {phase === 'sorted' && (
        <span className="hf-menu-in flex max-w-[48%] min-w-0 shrink-0 items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ background: 'var(--hue)' }}
          />
          <span className="min-w-0 truncate font-medium text-text-primary">{topic?.name}</span>
          {cell.newTopic ? (
            <span className="shrink-0 font-mono text-2xs tracking-wide text-accent uppercase">
              new
            </span>
          ) : (
            cell.score !== undefined && (
              <span className="shrink-0 font-mono text-2xs text-text-muted tabular-nums">
                {cell.score.toFixed(2)}
              </span>
            )
          )}
        </span>
      )}
    </div>
  );
}

/** Items on their way from the queue into their topic's pill. */
export function JoinLayer({
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
      {flights
        .filter((f) => f.phase === 'joining')
        .map((f) => (
          <Join
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

function Join({
  flight,
  topic,
  onLand,
}: {
  flight: Flight;
  topic: Topic | undefined;
  onLand: (id: string) => void;
}) {
  const { cell, from } = flight;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    // Its pill, or "+N" when the pill is folded away.
    const pill =
      document.querySelector<HTMLElement>(`[data-topic-pill="${CSS.escape(cell.topic)}"]`) ??
      document.querySelector<HTMLElement>('[data-topic-more]');
    if (!el || !pill || !from) {
      onLand(cell.id);
      return;
    }
    const b = pill.getBoundingClientRect();
    const anim = el.animate(
      [
        {
          transform: `translate(${from.left}px, ${from.top}px)`,
          width: `${from.width}px`,
          height: `${from.height}px`,
          opacity: 1,
        },
        {
          transform: `translate(${b.left}px, ${b.top}px)`,
          width: `${b.width}px`,
          height: `${b.height}px`,
          opacity: 1,
          offset: 0.8,
        },
        {
          transform: `translate(${b.left}px, ${b.top}px)`,
          width: `${b.width}px`,
          height: `${b.height}px`,
          opacity: 0,
        },
      ],
      { duration: BEATS.joinMs, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      onLand(cell.id);
      pill.animate(
        cell.newTopic
          ? [
              { transform: 'scale(0.6)', opacity: 0 },
              { transform: 'scale(1.08)' },
              { transform: 'scale(1)', opacity: 1 },
            ]
          : [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }],
        { duration: 420, easing: 'cubic-bezier(.3,1.5,.5,1)' }
      );
    };
    return () => {
      anim.onfinish = null;
    };
    // One join, one run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      style={{ '--hue': `var(--theme-${topic?.hue ?? 4})` } as CSSProperties}
      className="hf-join pointer-events-none fixed top-0 left-0 z-[60] flex items-center gap-2 overflow-hidden rounded-full pr-3 pl-2.5 text-xs whitespace-nowrap text-text-primary"
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: 'var(--hue)' }}
      />
      <span className="min-w-0 truncate">{topic?.name}</span>
    </div>
  );
}
