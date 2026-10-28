import { Check, Home, RefreshCw } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { SourceLogo } from '@renderer/features/home-feed/bits';
import type { SourceConnector } from '@renderer/features/home-feed/model';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import type { OrchProgressEvent, RunProblem } from '@shared/rig/orch-progress';
import { liveFirstRun, type ProgressSource } from './progress-source';
import {
  currentLine,
  firstForYou,
  initialRead,
  readReducer,
  sinceWords,
  type ReadLine,
  type ReadState,
  tickerLines,
} from './read-model';
import { reconnectCopy, stoppedCopy } from './problems';
import { RollingNumber } from './rolling-number';
import './read.css';

/**
 * Onboarding's Read step (onboarding spec, Step 5): Rig reading the person's
 * last few days while they watch. Three pieces over one reading of the run
 * (`useReadRun`): a header that says what it's doing right now, with three
 * counters that say what they count and roll when they change (`ReadHeader`,
 * on the stage); and a ticker where each line starts as "Checking…" and
 * settles to what it found (`ReadTicker`, in the guide pane). Between
 * lookups, a line says what Claude is thinking: it should never look stuck.
 * `ReadStep` puts them in one column, for the dev preview.
 */

/** What a fix button asks for: the run's stop reason, or a connector to reconnect. */
export type ReadFix = { problem?: RunProblem; connector?: string };

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

/** One reading of the run, shared by the header, the ticker and the stage. */
export type ReadRun = {
  state: ReadState;
  /** The run's own clock, for each line's "Checking…" moment. */
  now: number;
  /** The newest lookup still running. */
  current: ReadLine | null;
  /** Nothing running for a moment: Claude is deciding what to check next. */
  thinking: boolean;
};

/** Reads the run from `source`, passing every event on to `onProgress` as it comes. */
export function useReadRun(
  source: ProgressSource = liveFirstRun,
  onProgress?: (event: OrchProgressEvent) => void
): ReadRun {
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
  const now = useRunClock(state);
  const wall = useWallClock(!state.ended);
  const current = currentLine(state);
  const thinking = !state.ended && !current && wall - lastEventAt.current > THINKING_AFTER_MS;
  return { state, now, current, thinking };
}

export function summaryOf(state: ReadState): ReadSummary {
  return {
    cards: state.cards,
    counts: state.counts,
    ended: state.ended !== null,
    ok: state.ended?.ok ?? false,
  };
}

/** The read's title with its matrix: "Catching you up", then how it ended. */
export function ReadTitle({ run, className }: { run: ReadRun; className?: string }) {
  const { state, current } = run;
  const ended = state.ended;
  return (
    <div className={cn('flex items-center gap-3', className)} data-testid="read-title">
      <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-bg-2">
        <DotMatrix
          state={ended ? (ended.ok ? 'done' : 'failed') : current ? 'reading' : 'thinking'}
          tone={ended && ended.ok ? 'ok' : 'accent'}
          size="md"
        />
      </span>
      <h2 className="m-0 font-display text-[22px] leading-tight font-semibold tracking-[-0.015em] text-text-primary">
        {ended ? (ended.ok ? 'All caught up' : stoppedCopy(ended.problem, ended.error).title) : 'Catching you up'}
      </h2>
    </div>
  );
}

/**
 * What the read is doing: its title (unless the stage shows it) and the line
 * under it, the three counters, a reconnect for each connector that needs
 * one, and, when it stopped, its one fix.
 */
export function ReadHeader({
  run,
  title = true,
  onFix,
  onLeave,
  connectorsHome = 'claude.ai',
  fixing = false,
  className,
}: {
  run: ReadRun;
  /** Shows the title here; the first run's stage shows it instead. */
  title?: boolean;
  /** A stopped read's fix, or a connector's reconnect: with it, each problem gets its one button. */
  onFix?: (fix: ReadFix) => void;
  /** A stopped read's way out: to the Feed, with what it found so far. */
  onLeave?: () => void;
  /** Where the agent's connectors are reconnected ("claude.ai"), for the reconnect button. */
  connectorsHome?: string;
  /** A fix is under way (signing in): its button waits. */
  fixing?: boolean;
  className?: string;
}) {
  const { state, current, thinking } = run;
  const ended = state.ended;
  const stopped = ended && !ended.ok ? stoppedCopy(ended.problem, ended.error) : null;
  return (
    <section
      aria-label="Catching you up"
      className={cn('flex flex-col gap-3', className)}
      data-testid="read-header"
    >
      <div className="flex flex-col gap-1.5">
        {title && <ReadTitle run={run} />}
        <p
          className="m-0 min-h-[1.4em] truncate text-[13px] text-text-secondary"
          aria-live="polite"
          data-testid="read-now"
        >
          {status(state, current, thinking)}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="So far">
        <Counter value={state.counts.read} label="lookups in your tools" />
        <Counter
          value={state.counts.handled}
          label="already handled, skipped"
          className="text-status-ok"
        />
        <Counter
          value={state.counts.forYou}
          label={state.since ? 'new for your Feed' : 'cards for your Feed'}
          className="text-accent"
        />
      </div>
      {onFix &&
        state.problems
          .filter((p) => p.problem === 'connector_auth' && p.connector)
          .map((p) => {
            const copy = reconnectCopy(p.connector!, connectorsHome);
            return (
              <div
                key={p.connector}
                className="flex items-center gap-2.5 rounded-[10px] bg-bg-2 px-2.5 py-2 text-[13px]"
                data-testid="read-reconnect"
              >
                <DotMatrix state="waiting" size="sm" tone="mute" />
                <span className="min-w-0 flex-1 text-text-secondary">
                  <b className="font-medium text-text-primary">{copy.title}.</b> {copy.detail}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-meta text-accent hover:opacity-80"
                  onClick={() => onFix({ problem: 'connector_auth', connector: p.connector })}
                >
                  {copy.fix}
                </button>
              </div>
            );
          })}
      {stopped && onFix && (
        <div className="flex flex-wrap items-center gap-2.5">
          <ActionButton
            variant="primary"
            icon={RefreshCw}
            disabled={fixing}
            onClick={() => onFix({ problem: ended?.problem })}
            data-testid="read-fix"
          >
            {fixing ? 'Waiting…' : stopped.fix}
          </ActionButton>
          {onLeave && (
            <ActionButton variant="quiet" icon={Home} onClick={onLeave}>
              Open my Feed
            </ActionButton>
          )}
        </div>
      )}
    </section>
  );
}

/** The lines it read, newest last, settling to what each found; and what Claude thinks between them. */
export function ReadTicker({ run, className }: { run: ReadRun; className?: string }) {
  const { state, now, thinking } = run;
  const ended = state.ended;
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col justify-end gap-1 overflow-hidden [mask-image:linear-gradient(transparent,#000_22%)]',
        className
      )}
    >
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
          <span className="rig-read-shimmer truncate">
            {state.lines.length === 0
              ? 'Waking your Claude…'
              : state.thought
                ? `${state.thought}…`
                : 'Deciding what to check next…'}
          </span>
        </div>
      )}
    </div>
  );
}

/** The whole read in one column: the header, the ticker, and the way on once it ends. */
export function ReadStep({
  onDone,
  source = liveFirstRun,
  onProgress,
  onFix,
  connectorsHome = 'claude.ai',
  fixing = false,
}: {
  /** Leaves the step, to the Feed. */
  onDone: (summary: ReadSummary) => void;
  /** Where the progress comes from; the real first run when unset. */
  source?: ProgressSource;
  /** Every event as it comes. */
  onProgress?: (event: OrchProgressEvent) => void;
  onFix?: (fix: ReadFix) => void;
  connectorsHome?: string;
  fixing?: boolean;
}) {
  const run = useReadRun(source, onProgress);
  const { state } = run;
  const leave = () => onDone(summaryOf(state));
  const stopped = state.ended && !state.ended.ok;
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3.5" data-testid="read-step">
      <ReadHeader
        run={run}
        onFix={onFix}
        onLeave={leave}
        connectorsHome={connectorsHome}
        fixing={fixing}
      />
      <ReadTicker run={run} />
      {!(stopped && onFix) && (
        <div className="flex flex-wrap items-center gap-2.5">
          {state.ended && (
            <ActionButton variant="primary" icon={Home} onClick={leave}>
              Open my Feed
            </ActionButton>
          )}
          <span className="min-w-0 text-xs text-text-muted" data-testid="read-hint">
            {readHint(state)}
          </span>
        </div>
      )}
    </section>
  );
}

/** How far back it reads, in words: "since Tuesday" for a catch-up, else the last 3 days. */
export function windowWords(state: Pick<ReadState, 'since'>): string {
  return sinceWords(state.since) ?? 'from your last 3 days';
}

/** One line under the title: what it's doing this moment, or how it went. */
function status(state: ReadState, current: ReadLine | null, thinking: boolean): string {
  const { ended } = state;
  const checked = state.counts.read;
  const reading = state.since ? `Catching you up ${windowWords(state)}…` : 'Reading your last 3 days…';
  if (ended && !ended.ok) return stoppedCopy(ended.problem, ended.error).detail;
  if (ended) return `Checked ${checked} ${checked === 1 ? 'place' : 'places'} in your tools.`;
  if (current) return `${current.label}…`;
  if (!state.lines.length)
    return state.since ? `Catching you up ${windowWords(state)}…` : 'Starting to read your last 3 days…';
  if (thinking) {
    // What Claude says it's thinking, when it says; else what it has done so far.
    if (state.thought) return `${state.thought}…`;
    const done = state.lines
      .filter((l) => l.status !== 'running' && !!l.connector && l.connector !== 'rig')
      .at(-1);
    return done ? `${checked} so far · last: ${done.label}` : reading;
  }
  const last = state.lines.at(-1);
  return last ? last.label : reading;
}

/** The line beside the read's action: what it found first, or that nothing needs you. */
export function readHint(state: ReadState): string {
  const { ended } = state;
  if (ended && !ended.ok) return 'What it found so far is on your Feed.';
  const found = firstForYou(state);
  if (state.cards.length) {
    const what = found ? `Your first card: ${found.label}.` : 'Your first card is ready.';
    return ended ? what : `${what} Rig keeps reading the rest.`;
  }
  if (ended)
    return state.since
      ? `Nothing new needs you ${windowWords(state)}. Rig keeps an eye out from here.`
      : 'Nothing needs you yet. Rig keeps an eye out from here.';
  return 'Skipping anything already handled';
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
      <RollingNumber
        value={value}
        className={cn('font-display text-[22px] leading-[1.1] font-semibold', className)}
      />
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

/** Wall time, ticking twice a second while the run goes: it tells when to show the "deciding" line. */
function useWallClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
