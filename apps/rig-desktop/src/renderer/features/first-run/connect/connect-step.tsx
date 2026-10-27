import { ArrowRight, Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { SourceLogo } from '@renderer/features/home-feed/bits';
import { SettingsSwitch } from '@renderer/features/settings/settings-row';
import type { AgentFieldRegion } from '@renderer/lib/ui/agent-field';
import type { DotMatrixActivity } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import {
  FIRST_RUN_CONNECTORS,
  type ConnectorCheck,
  type FirstRunConnector,
} from '@shared/rig/first-run';
import { StepFrame, type StepProps } from '../first-run';
import './connect.css';

const NAME: Record<FirstRunConnector, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gmail: 'Gmail',
  calendar: 'Calendar',
  notion: 'Notion',
};

/** Each tool's color on the field, from the app's own tokens (as the Read step colors them). */
const COLOR: Record<FirstRunConnector, string> = {
  slack: '--theme-3',
  linear: '--theme-7',
  github: '--text-secondary',
  gmail: '--theme-8',
  calendar: '--theme-5',
  notion: '--text-secondary',
};

/** Where each tool's pin stands on the stage, as fractions of it: spread out, none on top of another. */
const AT: Record<FirstRunConnector, { x: number; y: number }> = {
  slack: { x: 0.3, y: 0.3 },
  linear: { x: 0.7, y: 0.24 },
  github: { x: 0.74, y: 0.66 },
  gmail: { x: 0.28, y: 0.72 },
  calendar: { x: 0.5, y: 0.5 },
  notion: { x: 0.52, y: 0.86 },
};

/** A tool that's on lights this many single tiles around its pin, scattered, in its color. */
const TILES_PER_TOOL = 7;
/** Each tile lands in a ring around the pin: clear of the pin itself, close enough to read as its own. */
const RING = { inner: 0.08, outer: 0.17, spot: 0.03 };
/** Found tools wake one after another, not all at once. */
const WAKE_STAGGER_MS = 220;
const ACTIVITY: DotMatrixActivity[] = ['reading', 'searching', 'thinking', 'waiting'];

type Checks = Record<FirstRunConnector, ConnectorCheck['state']>;

/**
 * Step 3: the tools the person's Claude already reaches. The pre-flight
 * reads them fresh, here and whenever the window comes back (a tool
 * connected in claude.ai lights up with no click). A switch per connected
 * tool says whether the catch-up reads it, written straight to the
 * orchestrator's sources; Catch me up writes the whole choice.
 */
export function ConnectStep({ env, position, onNext, setFieldLook, field }: StepProps) {
  useEffect(() => setFieldLook('plain'), [setFieldLook]);
  const { route } = env.agentInfo;
  const [checks, setChecks] = useState<Checks | null>(null);
  const [watching, setWatching] = useState<Partial<Record<FirstRunConnector, boolean>>>({});
  const [starting, setStarting] = useState(false);

  // The pre-flight, now and on every return to the window. The newest answer wins.
  const envRef = useRef(env);
  envRef.current = env;
  const asked = useRef(0);
  const check = useCallback(() => {
    const ask = ++asked.current;
    void envRef.current
      .preflight()
      .then((list) => {
        if (ask !== asked.current) return;
        setChecks(Object.fromEntries(list.map((c) => [c.connector, c.state])) as Checks);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    check();
    void envRef.current.readWatching().then(setWatching, () => undefined);
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [check]);

  const isOn = (c: FirstRunConnector) => checks?.[c] === 'connected' && watching[c] !== false;
  const on = FIRST_RUN_CONNECTORS.filter(isOn);
  const anyConnected =
    checks !== null && FIRST_RUN_CONNECTORS.some((c) => checks[c] === 'connected');

  // The stage: each tool that's on wakes a few tiles around its pin; off lets them go.
  const lit = useRef(new Set<FirstRunConnector>());
  const onKey = on.join(',');
  useEffect(() => {
    const now = new Set(onKey ? (onKey.split(',') as FirstRunConnector[]) : []);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let order = 0;
    for (const c of FIRST_RUN_CONNECTORS) {
      const was = lit.current.has(c);
      if (now.has(c) && !was) {
        lit.current.add(c);
        timers.push(
          setTimeout(() => {
            for (let i = 0; i < TILES_PER_TOOL; i++) {
              const activity = ACTIVITY[Math.floor(Math.random() * ACTIVITY.length)]!;
              field.current?.tile(`connect:${c}:${i}`, ringSpot(AT[c], i)).set(activity, COLOR[c]);
            }
          }, order++ * WAKE_STAGGER_MS)
        );
      } else if (!now.has(c) && was) {
        lit.current.delete(c);
        for (let i = 0; i < TILES_PER_TOOL; i++) field.current?.tile(`connect:${c}:${i}`).release();
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [onKey, field]);
  // Leaving the step lets every tile go.
  useEffect(
    () => () => {
      for (const c of lit.current)
        for (let i = 0; i < TILES_PER_TOOL; i++) field.current?.tile(`connect:${c}:${i}`).release();
      lit.current.clear();
    },
    [field]
  );

  const toggle = (c: FirstRunConnector) => {
    const next = !isOn(c);
    setWatching((w) => ({ ...w, [c]: next }));
    void env.setWatching(c, next).catch(() => undefined);
  };

  const catchUp = async () => {
    setStarting(true);
    try {
      // The whole choice: with no sources the read falls back to its defaults.
      for (const c of FIRST_RUN_CONNECTORS) {
        if (checks?.[c] === 'connected') await env.setWatching(c, isOn(c));
      }
    } catch {
      // The read still runs; it falls back to its usual tools.
    } finally {
      setStarting(false);
    }
    onNext();
  };

  return (
    <StepFrame
      guide={
        <>
          <span className="font-mono text-2xs tracking-[0.09em] text-text-muted uppercase">
            {position ? `${position} · Connect` : 'Connect'}
          </span>
          <h1 className="m-0 font-display text-2xl leading-[1.15] font-semibold tracking-[-0.015em] text-balance text-text-primary">
            Here’s what {route.yours} can reach.
          </h1>
          <p className="m-0 text-chat leading-[1.55] text-text-secondary">
            Rig works through the tools {route.yours} is already connected to. Nothing new to set
            up, and you can leave anything out.
          </p>
          {checks !== null && !anyConnected && (
            <p className="fr-in m-0 text-sm text-text-secondary" data-testid="connect-none">
              {capitalize(route.yours)} isn’t connected to any tools yet. Connect one in{' '}
              {route.connectorsHome} and it shows up here.
            </p>
          )}
          <div className="flex flex-col gap-0.5" data-testid="connect-rows">
            {FIRST_RUN_CONNECTORS.map((c) => (
              <ConnectorRow
                key={c}
                connector={c}
                state={checks?.[c] ?? null}
                on={isOn(c)}
                connectorsHome={route.connectorsHome}
                onToggle={() => toggle(c)}
                onConnect={() => env.openConnect(c)}
              />
            ))}
          </div>
          <div className="flex-1" />
          <div className="flex items-start gap-2 border-t border-border-hairline pt-3 text-meta text-text-muted">
            <Lock className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.8} />
            <span>Rig only reads. Anything that would leave Rig waits for your click.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <ActionButton
              variant="primary"
              icon={ArrowRight}
              onClick={() => void catchUp()}
              disabled={on.length === 0 || starting}
              data-testid="first-run-catch-me-up"
            >
              Catch me up
            </ActionButton>
            <span className="text-meta text-text-muted">
              {checks === null
                ? ''
                : on.length === 0
                  ? 'Connect one tool to begin'
                  : `Reads the last 3 days of ${on.length} tool${on.length > 1 ? 's' : ''}`}
            </span>
          </div>
        </>
      }
      stage={
        <div className="relative -m-6 self-stretch justify-self-stretch" aria-hidden>
          {checks !== null &&
            FIRST_RUN_CONNECTORS.filter((c) => checks[c] === 'connected').map((c, k) => (
              <Pin key={c} connector={c} on={isOn(c)} delayMs={k * WAKE_STAGGER_MS} />
            ))}
        </div>
      }
    />
  );
}

/** The i-th tile's spot: around the ring at an even angle, give or take, at a random distance. */
function ringSpot(at: { x: number; y: number }, i: number): AgentFieldRegion {
  const angle = ((i + Math.random() * 0.6) / TILES_PER_TOOL) * Math.PI * 2;
  const d = RING.inner + Math.random() * (RING.outer - RING.inner);
  // Kept off the stage's edges, where the field's mask fades it out.
  const clamp = (v: number) => Math.min(0.88, Math.max(0.12, v));
  return {
    x: clamp(at.x + Math.cos(angle) * d),
    y: clamp(at.y + Math.sin(angle) * d * 1.3),
    radius: RING.spot,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ConnectorRow({
  connector,
  state,
  on,
  connectorsHome,
  onToggle,
  onConnect,
}: {
  connector: FirstRunConnector;
  /** null while the first pre-flight hasn't answered. */
  state: ConnectorCheck['state'] | null;
  on: boolean;
  connectorsHome: string;
  onToggle: () => void;
  onConnect: () => void;
}) {
  const name = NAME[connector];
  const github = connector === 'github';
  const status =
    state === null
      ? 'Looking…'
      : state === 'connected'
        ? on
          ? github
            ? 'Signed in through gh'
            : 'Connected'
          : 'Left out'
        : state === 'needs_auth'
          ? github
            ? 'Sign in to gh again'
            : `Reconnect in ${connectorsHome}`
          : github
            ? 'Not signed in to gh'
            : 'Not connected yet';

  return (
    <div
      className={cn(
        'grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[11px] rounded-[10px] px-2 py-1.5 transition-[background-color,opacity] duration-300',
        state === null && 'opacity-35',
        state === 'connected' && on && 'bg-bg-2',
        state === 'connected' && !on && 'opacity-55'
      )}
      data-testid={`connect-row-${connector}`}
      data-state={state ?? 'checking'}
    >
      <span
        className={cn(
          'grid size-7 place-items-center rounded-lg',
          state === 'connected' && on ? 'bg-bg-1' : 'bg-bg-2',
          state !== 'connected' && state !== null && 'grayscale-[0.9]'
        )}
      >
        <SourceLogo connector={connector} size={16} />
      </span>
      <div className="min-w-0">
        <span className="block text-ui font-medium text-text-primary">{name}</span>
        <span
          className={cn(
            'block text-xs',
            state === 'needs_auth'
              ? 'text-status-warn'
              : on
                ? 'text-text-secondary'
                : 'text-text-muted'
          )}
        >
          {status}
        </span>
      </div>
      <span className="flex items-center">
        {state === 'connected' && (
          <SettingsSwitch
            id={`connect-${connector}`}
            label={`Read ${name}`}
            checked={on}
            onToggle={onToggle}
          />
        )}
        {(state === 'missing' || state === 'needs_auth') && (
          <button
            type="button"
            onClick={onConnect}
            className="text-meta text-accent hover:opacity-80"
            data-testid={`connect-open-${connector}`}
          >
            {state === 'needs_auth' ? 'Reconnect ↗' : github ? 'How ↗' : 'Connect ↗'}
          </button>
        )}
      </span>
    </div>
  );
}

/** A tool on the stage: its real logo, name and whether Rig reads it, on glass over its tiles. */
function Pin({
  connector,
  on,
  delayMs,
}: {
  connector: FirstRunConnector;
  on: boolean;
  delayMs: number;
}) {
  const at = AT[connector];
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
      data-testid={`connect-pin-${connector}`}
    >
      <div
        className={cn(
          'fr-pin fr-in gap-[9px] rounded-full py-[7px] pr-[13px] pl-2 transition-opacity duration-300',
          !on && 'opacity-40'
        )}
        style={{ animationDelay: `${delayMs}ms` }}
      >
        <span className="grid size-[26px] place-items-center rounded-full bg-bg-1">
          <SourceLogo connector={connector} size={15} />
        </span>
        <span className="text-left">
          <b className="block text-sm leading-tight font-medium text-text-primary">
            {NAME[connector]}
          </b>
          <span className="block text-xs leading-snug text-text-secondary">
            {on ? 'Connected' : 'Left out'}
          </span>
        </span>
      </div>
    </div>
  );
}
