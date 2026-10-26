import { ArrowRight, Check, Home } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { SourceLogo } from '@renderer/features/home-feed/bits';
import type { SourceConnector } from '@renderer/features/home-feed/model';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import { liveFirstRun, type ProgressSource } from './progress-source';
import { initialRead, progressOf, readReducer, type ReadLine, type ReadState, tickerLines } from './read-model';
import './read.css';

/**
 * Onboarding's Read step (onboarding spec, Step 5): Rig reading the person's
 * last few days while they watch. Three counters (read, already handled, for
 * you), a bar for how far through its lookups it is, and a ticker where each
 * line starts as "Checking…" and settles to what it found. Self-contained: the
 * first-run shell mounts it with `onDone`, and its stage field maps the same
 * progress to tiles through `onProgress`.
 */

export type ReadSummary = { cards: string[]; counts: ReadState['counts']; ended: boolean; ok: boolean };

/** A new line stays "Checking…" at least this long, so each one reads as a lookup that settled. */
const MIN_CHECKING_MS = 600;
const KNOWN_LOGOS: ReadonlySet<string> = new Set<SourceConnector>(['slack', 'linear', 'github', 'gmail', 'granola']);

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
  useEffect(
    () =>
      source.start((event) => {
        dispatch(event);
        onProgressRef.current?.(event);
      }),
    [source]
  );
  // The run's own clock, so a line's "Checking…" moment is measured the same way as its times.
  const now = useRunClock(state);

  const firstCard = state.cards.length > 0;
  const ended = state.ended;
  const summary = (): ReadSummary => ({ cards: state.cards, counts: state.counts, ended: ended !== null, ok: ended?.ok ?? false });

  return (
    <section aria-label="Catching you up" className="flex min-h-0 flex-1 flex-col gap-3.5" data-testid="read-step">
      <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.09em] text-text-muted uppercase">
        <DotMatrix state={ended ? (ended.ok ? 'done' : 'failed') : 'reading'} size="sm" />
        Catching you up
      </span>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="So far">
        <Counter value={state.counts.read} label="read" />
        <Counter value={state.counts.handled} label="already handled" className="text-status-ok" />
        <Counter value={state.counts.forYou} label="for you" className="text-accent" />
      </div>
      <div
        className="h-[3px] shrink-0 overflow-hidden rounded-full bg-bg-3"
        role="progressbar"
        aria-label="Reading"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressOf(state) * 100)}
      >
        <i
          className="block h-full rounded-full bg-[linear-gradient(90deg,var(--accent),color-mix(in_srgb,var(--accent)_50%,var(--status-ok)))] transition-[width] duration-500 ease-linear"
          style={{ width: `${progressOf(state) * 100}%` }}
        />
      </div>
      <ol
        className="flex min-h-0 flex-1 list-none flex-col justify-end gap-1 overflow-hidden [mask-image:linear-gradient(transparent,#000_22%)]"
        aria-live="polite"
        aria-label="What Rig is reading"
        data-testid="read-ticker"
      >
        {tickerLines(state).map((line) => (
          <TickerLine key={line.id} line={line} checking={line.status === 'running' || now - line.since < MIN_CHECKING_MS} />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2.5">
        {firstCard ? (
          <ActionButton variant="primary" icon={ArrowRight} onClick={() => onDone(summary())}>
            See the first one
          </ActionButton>
        ) : ended ? (
          <ActionButton variant="primary" icon={Home} onClick={() => onDone(summary())}>
            Open my Home
          </ActionButton>
        ) : null}
        <span className="text-xs text-text-muted" data-testid="read-hint">
          {hint(state)}
        </span>
      </div>
    </section>
  );
}

function hint(state: ReadState): string {
  const { ended } = state;
  if (ended && !ended.ok) return ended.error ? `Rig stopped reading: ${ended.error}` : 'Rig stopped reading.';
  if (state.cards.length) return ended ? 'Your first one is ready' : 'Your first one is ready. Rig keeps reading the rest.';
  if (ended) return 'Nothing needs you yet. Rig keeps an eye out from here.';
  return 'Skipping anything already handled';
}

function Counter({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div className="rounded-xl bg-bg-2 px-[11px] py-2.5">
      <b className={cn('block font-display text-[22px] leading-[1.1] font-semibold tabular-nums', className)}>{value}</b>
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
        settled && line.status === 'for_you' && 'bg-accent-subtle',
        settled && line.status === 'handled' && 'bg-[color-mix(in_srgb,var(--status-ok)_12%,transparent)]'
      )}
      data-status={checking ? 'checking' : line.status}
    >
      <span className="grid place-items-center">
        {line.connector && KNOWN_LOGOS.has(line.connector) ? (
          <SourceLogo connector={line.connector as SourceConnector} size={15} />
        ) : (
          <DotMatrix state={settled ? 'quiet' : 'searching'} size="sm" tone="mute" />
        )}
      </span>
      <span className={cn('line-clamp-2 min-w-0 leading-[1.4] transition-colors', settled ? 'text-text-secondary' : 'text-text-muted', settled && line.status === 'for_you' && 'text-text-primary')}>
        {checking && tag ? 'Checking…' : checking ? `${line.label}…` : line.label}
      </span>
      <span className="flex items-center">
        {checking ? (
          <DotMatrix state="searching" size="sm" />
        ) : tag ? (
          <span className={cn('font-mono text-[10px] font-medium tracking-[0.05em] uppercase', tag.className)}>{tag.text}</span>
        ) : line.status === 'failed' ? (
          <span className="font-mono text-[10px] tracking-[0.05em] text-text-muted uppercase">Couldn't read</span>
        ) : (
          <span className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--status-ok)_14%,transparent)] text-status-ok" aria-label="Read">
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
  const pending = state.lines.some((l) => l.status !== 'running' && now - l.since < MIN_CHECKING_MS);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => tick((n) => n + 1), 150);
    return () => clearTimeout(timer);
  });
  return now;
}
