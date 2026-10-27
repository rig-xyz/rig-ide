import { ArrowRight, Check, Home } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { SourceLogo } from '@renderer/features/home-feed/bits';
import type { SourceConnector } from '@renderer/features/home-feed/model';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import { liveFirstRun, type ProgressSource } from './progress-source';
import {
  checkedByConnector,
  currentLine,
  firstForYou,
  initialRead,
  progressOf,
  readReducer,
  type ReadLine,
  type ReadState,
  tickerLines,
} from './read-model';
import './read.css';

/**
 * Onboarding's Read step (onboarding spec, Step 5): Rig reading the person's
 * last few days while they watch. A header that says what it's doing right
 * now and for how long, three counters that say what they count (lookups in
 * which tools, things already handled, cards for you), a bar for how far
 * through its lookups it is, and a ticker where each line starts as
 * "Checking…" and settles to what it found. Between lookups, while Claude
 * decides what to check next, a line says so: it should never look stuck.
 * Self-contained: the first-run shell mounts it with `onDone`, and its stage
 * field maps the same progress to tiles through `onProgress`.
 */

export type ReadSummary = {
  cards: string[];
  counts: ReadState['counts'];
  ended: boolean;
  ok: boolean;
};

/** A new line stays "Checking…" at least this long, so each one reads as a lookup that settled. */
const MIN_CHECKING_MS = 600;
/** With nothing running for this long, say that Claude is deciding what to check next. */
const THINKING_AFTER_MS = 900;
const KNOWN_LOGOS: ReadonlySet<string> = new Set<SourceConnector>([
  'slack',
  'linear',
  'github',
  'gmail',
  'granola',
]);
const TOOL_NAME: Record<string, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gmail: 'Gmail',
  calendar: 'Calendar',
  notion: 'Notion',
  granola: 'Granola',
};

export function ReadStep({
  onDone,
  source = liveFirstRun,
  onProgress,
}: {
  /** Leaves the step: to the first card when one is ready, else to Home. */
  onDone: (summary: ReadSummary) => void;
  /** Where the progress comes from; the real first run when unset. */
  source?: ProgressSource;
  /** Every event as it comes, for the stage's field (one tile per line). */
  onProgress?: (event: OrchProgressEvent) => void;
}) {
  const [state, dispatch] = useReducer(readReducer, initialRead);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const lastEventAt = useRef(Date.now());
  useEffect(
    () =>
      source.start((event) => {
        lastEventAt.current = Date.now();
        dispatch(event);
        onProgressRef.current?.(event);
      }),
    [source]
  );
  // The run's own clock, so a line's "Checking…" moment is measured the same way as its times.
  const now = useRunClock(state);
  const wall = useWallClock(!state.ended);
  const startedAt = useRef(Date.now());
  const elapsed = (state.ended ? state.ended.t : wall - startedAt.current) / 1000;

  const firstCard = state.cards.length > 0;
  const ended = state.ended;
  const summary = (): ReadSummary => ({
    cards: state.cards,
    counts: state.counts,
    ended: ended !== null,
    ok: ended?.ok ?? false,
  });
  const current = currentLine(state);
  const thinking = !ended && !current && wall - lastEventAt.current > THINKING_AFTER_MS;
  const by = checkedByConnector(state);

  return (
    <section
      aria-label="Catching you up"
      className="flex min-h-0 flex-1 flex-col gap-3.5"
      data-testid="read-step"
    >
      <header className="flex flex-col gap-1.5" data-testid="read-header">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-[11px] bg-bg-2',
              !ended && 'rig-read-pulse'
            )}
          >
            <DotMatrix
              state={ended ? (ended.ok ? 'done' : 'failed') : current ? 'reading' : 'thinking'}
              tone={ended && ended.ok ? 'ok' : 'accent'}
              size="md"
            />
          </span>
          <h2 className="m-0 font-display text-[22px] leading-tight font-semibold tracking-[-0.015em] text-text-primary">
            {ended ? (ended.ok ? 'All caught up' : 'Rig stopped reading') : 'Catching you up'}
          </h2>
          <span
            className="ml-auto font-mono text-xs text-text-muted tabular-nums"
            aria-label="Time so far"
          >
            {clock(elapsed)}
          </span>
        </div>
        <p
          className="m-0 min-h-[1.4em] truncate text-[13px] text-text-secondary"
          aria-live="polite"
          data-testid="read-now"
        >
          {status(state, current, thinking, elapsed)}
        </p>
      </header>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="So far">
        <Counter value={state.counts.read} label="lookups in your tools" />
        <Counter
          value={state.counts.handled}
          label="already handled, skipped"
          className="text-status-ok"
        />
        <Counter value={state.counts.forYou} label="cards for your Feed" className="text-accent" />
      </div>
      {by.length > 0 && (
        <div
          className="-mt-1 flex flex-wrap gap-1.5"
          aria-label="Lookups by tool"
          data-testid="read-by-tool"
        >
          {by.map(({ connector, count }) => (
            <span
              key={connector}
              className="rig-read-chip inline-flex items-center gap-1.5 rounded-full bg-bg-2 py-[3px] pr-2.5 pl-1.5 text-xs text-text-secondary"
            >
              {KNOWN_LOGOS.has(connector) ? (
                <SourceLogo connector={connector as SourceConnector} size={13} />
              ) : (
                <DotMatrix state="quiet" size="sm" tone="mute" />
              )}
              {TOOL_NAME[connector] ?? connector}
              <b className="font-mono font-medium text-text-primary tabular-nums">{count}</b>
            </span>
          ))}
        </div>
      )}
      <div
        className="h-[3px] shrink-0 overflow-hidden rounded-full bg-bg-3"
        role="progressbar"
        aria-label="Reading"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressOf(state) * 100)}
      >
        <i
          className={cn(
            'block h-full rounded-full bg-[linear-gradient(90deg,var(--accent),color-mix(in_srgb,var(--accent)_50%,var(--status-ok)))] transition-[width] duration-500 ease-linear',
            !ended && 'rig-read-bar'
          )}
          style={{ width: `${progressOf(state) * 100}%` }}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-1 overflow-hidden [mask-image:linear-gradient(transparent,#000_22%)]">
        <ol
          className="m-0 flex list-none flex-col gap-1 p-0"
          aria-live="polite"
          aria-label="What Rig is reading"
          data-testid="read-ticker"
        >
          {tickerLines(state).map((line) => (
            <TickerLine
              key={line.id}
              line={line}
              checking={line.status === 'running' || now - line.since < MIN_CHECKING_MS}
            />
          ))}
        </ol>
        {!ended && (thinking || state.lines.length === 0) && (
          <div
            className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-2.5 px-2.5 py-[7px] text-[13px]"
            data-testid="read-thinking"
          >
            <span className="grid place-items-center">
              <DotMatrix state="thinking" size="sm" />
            </span>
            <span className="rig-read-shimmer">
              {state.lines.length === 0 ? 'Waking your Claude…' : 'Deciding what to check next…'}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {firstCard ? (
          <ActionButton variant="primary" icon={ArrowRight} onClick={() => onDone(summary())}>
            See it on your Feed
          </ActionButton>
        ) : ended ? (
          <ActionButton variant="primary" icon={Home} onClick={() => onDone(summary())}>
            Open my Feed
          </ActionButton>
        ) : null}
        <span className="min-w-0 text-xs text-text-muted" data-testid="read-hint">
          {hint(state)}
        </span>
      </div>
    </section>
  );
}

/** One line under the title: what it's doing this moment, or how it went. */
function status(
  state: ReadState,
  current: ReadLine | null,
  thinking: boolean,
  elapsed: number
): string {
  const { ended } = state;
  const checked = state.counts.read;
  if (ended && !ended.ok) return ended.error ?? 'Something went wrong while reading.';
  if (ended)
    return `Checked ${checked} ${checked === 1 ? 'place' : 'places'} in your tools in ${clock(elapsed)}. ${state.counts.forYou} ${state.counts.forYou === 1 ? 'card is' : 'cards are'} on your Feed.`;
  if (current) return `${current.label}…`;
  if (!state.lines.length) return 'Starting to read your last 3 days…';
  if (thinking) {
    // The ticker already says it's deciding; up here, what it has done so far.
    const done = state.lines.filter((l) => l.status !== 'running' && l.connector !== 'rig').at(-1);
    return done ? `${checked} so far · last: ${done.label}` : 'Reading your last 3 days…';
  }
  const last = state.lines.at(-1);
  return last ? last.label : 'Reading your last 3 days…';
}

function hint(state: ReadState): string {
  const { ended } = state;
  if (ended && !ended.ok) return 'What it found so far is on your Feed.';
  const found = firstForYou(state);
  if (state.cards.length) {
    const what = found ? `Your first card: ${found.label}.` : 'Your first card is ready.';
    return ended ? what : `${what} Rig keeps reading the rest.`;
  }
  if (ended) return 'Nothing needs you yet. Rig keeps an eye out from here.';
  return 'Skipping anything already handled';
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Counter({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  return (
    <div className="rounded-xl bg-bg-2 px-[11px] py-2.5">
      <b
        key={value}
        className={cn(
          'rig-read-count block font-display text-[22px] leading-[1.1] font-semibold tabular-nums',
          className
        )}
      >
        {value}
      </b>
      <span className="block text-[11.5px] leading-tight text-text-muted">{label}</span>
    </div>
  );
}

const TAG: Partial<Record<ReadLine['status'], { text: string; className: string }>> = {
  handled: { text: 'Already done', className: 'text-status-ok' },
  not_yours: { text: 'Not yours', className: 'text-text-muted' },
  for_you: { text: 'For you', className: 'text-accent' },
};

function TickerLine({ line, checking }: { line: ReadLine; checking: boolean }) {
  const tag = TAG[line.status];
  const settled = !checking;
  return (
    <li
      className={cn(
        'rig-read-line grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-[13px] transition-colors duration-300',
        checking && 'bg-bg-2',
        settled && line.status === 'for_you' && 'bg-accent-subtle',
        settled &&
          line.status === 'handled' &&
          'bg-[color-mix(in_srgb,var(--status-ok)_12%,transparent)]'
      )}
      data-status={checking ? 'checking' : line.status}
      data-connector={line.connector ?? 'none'}
    >
      <span className="grid place-items-center">
        {/* Its own connector's mark, or a neutral one: never another connector's. */}
        {line.connector && KNOWN_LOGOS.has(line.connector) ? (
          <SourceLogo connector={line.connector as SourceConnector} size={15} />
        ) : (
          <DotMatrix state={settled ? 'quiet' : 'searching'} size="sm" tone="mute" />
        )}
      </span>
      <span
        className={cn(
          'line-clamp-2 min-w-0 leading-[1.4] transition-colors',
          settled ? 'text-text-secondary' : 'text-text-primary',
          settled && line.status === 'for_you' && 'text-text-primary'
        )}
      >
        {checking && tag ? 'Checking…' : checking ? `${line.label}…` : line.label}
      </span>
      <span className="flex items-center">
        {checking ? (
          <DotMatrix state="searching" size="sm" />
        ) : tag ? (
          <span
            className={cn(
              'font-mono text-[10px] font-medium tracking-[0.05em] uppercase',
              tag.className
            )}
          >
            {tag.text}
          </span>
        ) : line.status === 'failed' ? (
          <span className="font-mono text-[10px] tracking-[0.05em] text-text-muted uppercase">
            Couldn't read
          </span>
        ) : (
          <span
            className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--status-ok)_14%,transparent)] text-status-ok"
            aria-label="Read"
          >
            <Check className="size-[11px]" strokeWidth={2.4} />
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * The run's clock: time since its start, from the newest event plus the wall
 * time since it came. Ticks only while some line is still in its "Checking…"
 * moment, so a quiet ticker doesn't re-render.
 */
function useRunClock(state: ReadState): number {
  const anchor = useRef<{ t: number; at: number }>({ t: 0, at: Date.now() });
  const newest = state.lines.reduce((max, l) => Math.max(max, l.t), 0);
  if (newest > anchor.current.t) anchor.current = { t: newest, at: Date.now() };
  const [, tick] = useState(0);
  const now = anchor.current.t + (Date.now() - anchor.current.at);
  const pending = state.lines.some(
    (l) => l.status !== 'running' && now - l.since < MIN_CHECKING_MS
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => tick((n) => n + 1), 150);
    return () => clearTimeout(timer);
  });
  return now;
}

/** Wall time, ticking twice a second while the run goes: the elapsed clock and the "deciding" line. */
function useWallClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
