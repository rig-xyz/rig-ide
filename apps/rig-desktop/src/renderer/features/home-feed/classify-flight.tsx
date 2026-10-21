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
import type { Cell, Topic } from './connectors-model';
import type { SourceConnector } from './model';

/**
 * A new item being classified, shown as it happens. It opens inside the row
 * of the connector that brought it, as a line under its status ("ULY-521 …
 * Sorting…"), pushing the rows below down; it resolves to its topic and how
 * sure the sorting was; then the line folds away and a square of its topic's
 * color drops from there into its place in today's grid, which pulses as the
 * topic's pill bumps. Items that arrive together go one after another.
 */

export type FlightPhase = 'waiting' | 'reading' | 'sorted' | 'dropping';

export interface Flight {
  cell: Cell;
  phase: FlightPhase;
  /** Where the line was when it folded: the square starts there. */
  from?: { left: number; top: number; width: number; height: number };
}

/** Between items of one check, and the line's beats: open, sorted, then the drop. */
const STAGGER_MS = 900;
const BEATS = { sorted: 900, drop: 1800, dropMs: 650 } as const;

/** Flights for the cells that arrive while the grid is on screen; reduced motion lets them simply appear. */
export function useClassifyFlights(cells: readonly Cell[], reduced: boolean) {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(cells.map((c) => c.id));
  const [flights, setFlights] = useState<Flight[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const setPhase = useCallback((id: string, phase: FlightPhase) => {
    setFlights((current) =>
      current.map((f) => {
        if (f.cell.id !== id) return f;
        if (phase !== 'dropping') return { ...f, phase };
        // The line is still on screen: the square starts where it is.
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
      const at = (ms: number, phase: FlightPhase) => {
        const t = setTimeout(
          () => {
            timers.current.delete(t);
            setPhase(cell.id, phase);
          },
          i * STAGGER_MS + ms
        );
        timers.current.add(t);
      };
      at(0, 'reading');
      at(BEATS.sorted, 'sorted');
      at(BEATS.drop, 'dropping');
    });
  }, [cells, reduced, setPhase]);

  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
    };
  }, []);

  const land = useCallback(
    (id: string) => setFlights((current) => current.filter((f) => f.cell.id !== id)),
    []
  );
  return { flights, flying: new Set(flights.map((f) => f.cell.id)), land };
}

/** The line inside a connector's row while one of its items is being classified. */
export function ClassifyLine({
  connector,
  flights,
  topics,
}: {
  connector: SourceConnector;
  flights: readonly Flight[];
  topics: readonly Topic[];
}) {
  const flight = flights.find(
    (f) => f.cell.connector === connector && (f.phase === 'reading' || f.phase === 'sorted')
  );
  const topic = flight ? topics.find((t) => t.id === flight.cell.topic) : undefined;
  return (
    <AnimatePresence initial={false}>
      {flight && (
        <motion.div
          key={flight.cell.id}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="overflow-hidden pl-[34px]"
        >
          <div
            data-classify-line={flight.cell.id}
            style={{ '--hue': `var(--theme-${topic?.hue ?? 4})` } as CSSProperties}
            className="mt-1.5 mb-1 flex h-7 max-w-full items-center gap-2 rounded-full bg-bg-2/70 px-2.5 text-xs whitespace-nowrap"
          >
            <span className="font-mono text-2xs text-text-secondary">{flight.cell.ref}</span>
            {flight.phase === 'reading' ? (
              <>
                <span className="min-w-0 truncate text-text-primary">{flight.cell.title}</span>
                <DotMatrix state="thinking" size="sm" />
                <span className="shrink-0 text-text-muted">Sorting…</span>
              </>
            ) : (
              <>
                <span className="text-text-muted">→</span>
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: 'var(--hue)' }}
                />
                <span className="min-w-0 truncate font-medium text-text-primary">
                  {topic?.name}
                </span>
                {flight.cell.newTopic ? (
                  <span className="shrink-0 font-mono text-2xs tracking-wide text-accent uppercase">
                    new topic
                  </span>
                ) : (
                  flight.cell.score !== undefined && (
                    <span className="shrink-0 font-mono text-2xs text-text-muted tabular-nums">
                      {flight.cell.score.toFixed(2)}
                    </span>
                  )
                )}
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The squares on their way from a folded line to their place in the grid. */
export function DropLayer({
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
        .filter((f) => f.phase === 'dropping')
        .map((f) => (
          <Drop
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

function Drop({
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
    const target = document.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cell.id)}"]`);
    if (!el || !target || !from) {
      onLand(cell.id);
      return;
    }
    const b = target.getBoundingClientRect();
    // The square leaves from the line's left end, where its color dot was.
    const sx = from.left + 8;
    const sy = from.top + from.height / 2 - 7;
    const anim = el.animate(
      [
        {
          transform: `translate(${sx}px, ${sy}px) scale(1)`,
          width: '14px',
          height: '14px',
          borderRadius: '7px',
        },
        {
          transform: `translate(${sx + (b.left - sx) * 0.5}px, ${sy + (b.top - sy) * 0.35 - 16}px) scale(1.15)`,
          width: '14px',
          height: '14px',
          borderRadius: '5px',
          offset: 0.5,
        },
        {
          transform: `translate(${b.left}px, ${b.top}px) scale(1)`,
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
    // One drop, one run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      style={{ '--hue': `var(--theme-${topic?.hue ?? 4})` } as CSSProperties}
      className="hf-drop pointer-events-none fixed top-0 left-0 z-[60]"
    />
  );
}
