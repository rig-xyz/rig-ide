import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { AgentSignInButton } from '@renderer/features/agents/agent-sign-in-button';
import { useAgentSignInNeeded } from '@renderer/features/agents/use-agent-sign-in-needed';
import { agentRoute, ROUTED_AGENT_ID } from '@renderer/features/first-run/agent-route';
import { liveCatchUp, type ProgressSource } from '@renderer/features/first-run/read/progress-source';
import { reconnectCopy, stoppedCopy } from '@renderer/features/first-run/read/problems';
import {
  currentLine,
  initialRead,
  readReducer,
  sinceWords,
  type ReadState,
} from '@renderer/features/first-run/read/read-model';
import { RollingNumber } from '@renderer/features/first-run/read/rolling-number';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { ActionButton } from './action-button';
import { RIG_FEED_KEY } from './use-real-feed';
import '@renderer/features/first-run/read/read.css';

/**
 * The morning catch-up on Home (main's catch-up.ts): when Rig was away for
 * hours, a short run reads what came in since, shown as one compact strip at
 * the top of the Feed: the same counters, live line, "deciding" line and grey
 * read tiles as the first run's Read step, from the same model. It ends in
 * one line, While you were away, then fades. A run that stopped stays, with
 * its one fix.
 */

/** How long While you were away stays before the strip fades. */
const SUMMARY_MS = 9000;
const FADE_MS = 700;
/** With nothing running for this long, say that Claude is deciding what to check next. */
const THINKING_AFTER_MS = 900;
/** Grey tiles, one per finished lookup, up to what fits on one row. */
const MAX_TILES = 48;

export function CatchUpStrip({
  needsYou,
  source = liveCatchUp,
}: {
  /** What needs the person on the Feed now, for While you were away. */
  needsYou: number;
  source?: ProgressSource;
}) {
  const [state, dispatch] = useReducer(readReducer, initialRead);
  const lastEventAt = useRef(Date.now());
  const [phase, setPhase] = useState<'live' | 'fading' | 'gone'>('live');
  const [attempt, setAttempt] = useState(0);
  useEffect(
    () =>
      source.start((event) => {
        lastEventAt.current = Date.now();
        // A new catch-up (the Mac woke again) shows again.
        if (event.kind === 'start') setPhase('live');
        dispatch(event);
      }),
    [source, attempt]
  );
  const wall = useWallClock(state.run !== null && !state.ended);

  // While you were away, a moment, then it fades and goes.
  const okEnd = state.ended?.ok === true;
  useEffect(() => {
    if (!okEnd) return;
    const fade = setTimeout(() => setPhase('fading'), SUMMARY_MS);
    const gone = setTimeout(() => setPhase('gone'), SUMMARY_MS + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [okEnd]);

  if (state.run === null || phase === 'gone') return null;

  const current = currentLine(state);
  const thinking = !state.ended && !current && wall - lastEventAt.current > THINKING_AFTER_MS;
  const span = sinceWords(state.since);
  const stopped = state.ended && !state.ended.ok ? stoppedCopy(state.ended.problem, state.ended.error) : null;
  const { read, handled, forYou } = state.counts;
  const reconnect = state.problems.find((p) => p.problem === 'connector_auth' && p.connector);

  return (
    <section
      aria-label="Catching you up"
      aria-live="polite"
      data-testid="catch-up-strip"
      data-phase={phase}
      className={cn(
        'mx-4 mb-2 flex flex-col gap-1.5 rounded-xl bg-bg-2 px-3 py-2.5 transition-opacity',
        phase === 'fading' && 'opacity-0'
      )}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="flex items-center gap-2.5">
        <DotMatrix
          state={state.ended ? (state.ended.ok ? 'done' : 'failed') : current ? 'reading' : 'thinking'}
          tone={okEnd ? 'ok' : 'accent'}
          size="sm"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
          {stopped ? stopped.title : okEnd ? 'While you were away' : `Catching you up${span ? ` ${span}` : ''}`}
        </span>
        {/* While it reads; at the end the summary line says it. */}
        {!state.ended && (
          <span className="flex shrink-0 items-baseline gap-2 text-[11.5px] text-text-muted" role="group" aria-label="So far">
            <Count value={read} label="read" />
            <Count value={handled} label="handled" className="text-status-ok" />
            <Count value={forYou} label="new" className="text-accent" />
          </span>
        )}
        {(stopped || okEnd) && (
          <button
            type="button"
            aria-label="Dismiss"
            className="grid size-5 shrink-0 place-items-center rounded text-text-muted hover:text-text-secondary"
            onClick={() => setPhase('gone')}
          >
            <X className="size-3.5" strokeWidth={1.8} />
          </button>
        )}
      </div>
      <p className="m-0 truncate text-xs text-text-secondary" data-testid="catch-up-line">
        {stopped ? (
          stopped.detail
        ) : okEnd ? (
          <span data-testid="catch-up-summary">{awayLine(state, needsYou)}</span>
        ) : current ? (
          `${current.label}…`
        ) : (
          <span className={cn(thinking && 'rig-read-shimmer')}>
            {state.lines.length === 0 ? 'Waking your Claude…' : 'Deciding what to check next…'}
          </span>
        )}
      </p>
      {!state.ended && <Tiles state={state} />}
      {reconnect && !okEnd && (
        <ReconnectLine connector={reconnect.connector!} />
      )}
      {stopped && (
        <Fix state={state} label={stopped.fix} onRetry={() => setAttempt((n) => n + 1)} />
      )}
    </section>
  );
}

/** While you were away, in one line: what's new, what was let go, what needs you now. */
export function awayLine(state: Pick<ReadState, 'counts'>, needsYou: number): string {
  const { forYou, handled } = state.counts;
  return `${forYou} new · ${handled} handled · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`;
}

function Count({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <RollingNumber value={value} className={cn('text-[13px] font-semibold text-text-primary', className)} />
      {label}
    </span>
  );
}

/** One grey tile per lookup that finished; the one reading now lit. */
function Tiles({ state }: { state: ReadState }) {
  const lookups = state.lines.filter((l) => l.connector && l.connector !== 'rig' && (l.status === 'done' || l.status === 'running'));
  if (!lookups.length) return null;
  return (
    <div className="flex h-[7px] flex-wrap gap-[3px] overflow-hidden" aria-hidden data-testid="catch-up-tiles">
      {lookups.slice(-MAX_TILES).map((l) => (
        <i
          key={l.id}
          className={cn(
            'block size-[7px] rounded-[2px]',
            l.status === 'running' ? 'animate-pulse bg-accent' : 'bg-[color-mix(in_srgb,var(--text-muted)_45%,transparent)]'
          )}
        />
      ))}
    </div>
  );
}

function ReconnectLine({ connector }: { connector: string }) {
  const route = agentRoute(ROUTED_AGENT_ID);
  const copy = reconnectCopy(connector, route.connectorsHome);
  return (
    <p className="m-0 flex items-center gap-2 text-xs text-text-secondary" data-testid="catch-up-reconnect">
      <span className="min-w-0 flex-1 truncate">{copy.title}.</span>
      <button
        type="button"
        className="shrink-0 text-accent hover:opacity-80"
        onClick={() => confirmOpenExternalLink(connector === 'github' ? 'https://cli.github.com/manual/gh_auth_login' : route.connectorsUrl)}
      >
        {copy.fix}
      </button>
    </p>
  );
}

/** A stopped catch-up's one fix: sign in to Rig or to Claude, then try again; or just try again. */
function Fix({ state, label, onRetry }: { state: ReadState; label: string; onRetry: () => void }) {
  const queryClient = useQueryClient();
  const problem = state.ended?.problem;
  const again = async () => {
    await rpc.rig.orch.catchUpNow().catch(() => undefined);
    onRetry();
  };
  const rig = useRigSignIn(() => {
    void queryClient.invalidateQueries({ queryKey: RIG_FEED_KEY });
    void again();
  });
  const claude = useAgentSignInNeeded('claude');
  const [busy, setBusy] = useState(false);

  if (problem === 'agent_signed_out' && claude.agent && claude.loginMethod) {
    return (
      <div className="flex items-center gap-2" data-testid="catch-up-fix">
        <AgentSignInButton
          agent={claude.agent}
          loginMethod={claude.loginMethod}
          onSignedIn={() => {
            claude.markSignedIn();
            void again();
          }}
          className="text-xs font-medium text-accent hover:opacity-80"
        />
        <span className="text-xs text-text-muted">to Claude, then Rig catches you up.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2" data-testid="catch-up-fix">
      <ActionButton
        size="sm"
        variant="quiet"
        icon={RefreshCw}
        disabled={busy || rig.phase !== 'idle'}
        onClick={async () => {
          if (problem === 'rig_signed_out') {
            void rig.signIn();
            return;
          }
          setBusy(true);
          await again();
          setBusy(false);
        }}
      >
        {rig.phase !== 'idle' ? 'Waiting for sign-in…' : label}
      </ActionButton>
      {rig.error && <span className="text-xs text-status-error">{rig.error}</span>}
    </div>
  );
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
