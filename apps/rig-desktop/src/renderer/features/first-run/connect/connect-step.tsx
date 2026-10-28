import { ArrowRight, Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { SettingsSwitch } from '@renderer/features/settings/settings-row';
import type { AgentFieldRegion } from '@renderer/lib/ui/agent-field';
import type { DotMatrixActivity } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import {
  toolKey,
  type ConnectorCheck,
  type KnownTool,
} from '@shared/rig/first-run';
import { NotNow, StepFrame, type StepProps } from '../first-run';
import { lastCatchUpWords } from '../read/read-model';
import { readingNow, readsNow, watched, withWatched, type Watching } from './sources';
import { ToolMark } from './tool-mark';
import './connect.css';

/** A known tool's color on the field, from the app's own tokens (as the Read step colors them). */
const COLOR: Record<KnownTool, string> = {
  slack: '--theme-3',
  linear: '--theme-7',
  github: '--text-secondary',
  gmail: '--theme-8',
  calendar: '--theme-5',
  notion: '--text-secondary',
  granola: '--theme-4',
};
/** Any other tool takes one of these, in turn. */
const OTHER_COLORS = ['--theme-1', '--theme-2', '--theme-6', '--theme-4'];

/** At most this many pins on the stage; more tools still get their rows. */
const MAX_PINS = 10;

/**
 * Where the i-th of n pins stands on the stage, as fractions of it: two
 * staggered columns, spread evenly down it, none on top of another.
 */
export function pinSpot(i: number, n: number): { x: number; y: number } {
  if (n === 1) return { x: 0.5, y: 0.5 };
  return { x: i % 2 ? 0.68 : 0.32, y: 0.14 + (0.72 * (i + 0.5)) / n };
}

/** A tool that's on lights this many single tiles around its pin, scattered, in its color. */
const TILES_PER_TOOL = 7;
/** Each tile lands in a ring around the pin: clear of the pin itself, close enough to read as its own. */
const RING = { inner: 0.08, outer: 0.17, spot: 0.03 };
/** Found tools wake one after another, not all at once. */
const WAKE_STAGGER_MS = 220;
const ACTIVITY: DotMatrixActivity[] = ['reading', 'searching', 'thinking', 'waiting'];

/**
 * Step 3: the tools the person's Claude already reaches. The pre-flight
 * reads them fresh, here and whenever the window comes back (a tool
 * connected in claude.ai lights up with no click). A switch per connected
 * tool says whether the catch-up reads it, written straight to the
 * orchestrator's sources; Catch me up writes the whole choice.
 */
export function ConnectStep({ env, position, onNext, onSkip, setFieldLook, field }: StepProps) {
  useEffect(() => setFieldLook('plain'), [setFieldLook]);
  const { route } = env.agentInfo;
  const [checks, setChecks] = useState<ConnectorCheck[] | null>(null);
  const [watching, setWatching] = useState<Watching>({});
  const [starting, setStarting] = useState(false);
  // Someone Rig already reads for: the switches start from what it reads now, and Continue changes
  // nothing unless they flip one. undefined while it's asked; null for someone new.
  const [since, setSince] = useState<string | null | undefined>(undefined);
  const flipped = useRef(false);

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
        setChecks(list);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    check();
    void envRef.current.readWatching().then(setWatching, () => undefined);
    void envRef.current.catchUpSince().then(setSince, () => setSince(null));
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [check]);

  const existing = typeof since === 'string';
  const tools = checks ?? [];
  const connected = tools.filter((t) => t.state === 'connected');
  // All on by default for someone new; as Rig reads now for someone it already reads for.
  const isOn = (t: ConnectorCheck) =>
    t.state === 'connected' &&
    (existing ? readsNow(watching, t.connector) : watched(watching, t.connector) !== false);
  const on = tools.filter(isOn);
  const anyConnected = checks !== null && connected.length > 0;

  // The stage: each tool that's on wakes a few tiles around its pin; off lets them go.
  const pinned = connected.slice(0, MAX_PINS);
  const lit = useRef(new Set<string>());
  const onKey = on.map((t) => toolKey(t.connector)).join('\n');
  const pinKey = pinned.map((t) => `${toolKey(t.connector)}:${t.known ?? ''}`).join('\n');
  useEffect(() => {
    const now = new Set(onKey ? onKey.split('\n') : []);
    const spots = pinKey ? pinKey.split('\n').map((line) => line.split(':')) : [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let order = 0;
    spots.forEach(([key, known], k) => {
      if (!key) return;
      const was = lit.current.has(key);
      if (now.has(key) && !was) {
        lit.current.add(key);
        const color = known ? COLOR[known as KnownTool] : OTHER_COLORS[k % OTHER_COLORS.length]!;
        const at = pinSpot(k, spots.length);
        timers.push(
          setTimeout(() => {
            for (let i = 0; i < TILES_PER_TOOL; i++) {
              const activity = ACTIVITY[Math.floor(Math.random() * ACTIVITY.length)]!;
              field.current?.tile(`connect:${key}:${i}`, ringSpot(at, i)).set(activity, color);
            }
          }, order++ * WAKE_STAGGER_MS)
        );
      } else if (!now.has(key) && was) {
        lit.current.delete(key);
        for (let i = 0; i < TILES_PER_TOOL; i++) field.current?.tile(`connect:${key}:${i}`).release();
      }
    });
    return () => timers.forEach(clearTimeout);
  }, [onKey, pinKey, field]);
  // Leaving the step lets every tile go.
  useEffect(
    () => () => {
      for (const key of lit.current)
        for (let i = 0; i < TILES_PER_TOOL; i++) field.current?.tile(`connect:${key}:${i}`).release();
      lit.current.clear();
    },
    [field]
  );

  const toggle = (t: ConnectorCheck) => {
    flipped.current = true;
    const next = !isOn(t);
    // Someone read with the defaults: those stay on when they flip another.
    setWatching((w) => withWatched({ ...(existing ? readingNow(w) : {}), ...w }, t.connector, next));
    void env.setWatching(t.connector, next).catch(() => undefined);
  };

  const catchUp = async () => {
    // As Rig reads now, untouched: nothing to write.
    if (existing && !flipped.current) {
      onNext();
      return;
    }
    setStarting(true);
    try {
      // The whole choice: with no sources the read falls back to its defaults.
      for (const t of connected) await env.setWatching(t.connector, isOn(t));
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
            {checks === null && <ConnectorRow tool={null} on={false} connectorsHome={route.connectorsHome} onToggle={() => {}} onConnect={() => {}} />}
            {tools.map((t) => (
              <ConnectorRow
                key={toolKey(t.connector)}
                tool={t}
                on={isOn(t)}
                connectorsHome={route.connectorsHome}
                onToggle={() => toggle(t)}
                onConnect={() => env.openConnect(t.connector)}
              />
            ))}
            {checks !== null && (
              <button
                type="button"
                onClick={() => env.openConnect()}
                className="self-start px-2 pt-1.5 text-meta text-text-muted transition-colors hover:text-text-primary"
                data-testid="connect-more"
              >
                Connect more in {route.connectorsHome} ↗
              </button>
            )}
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
                  : existing
                    ? `Reads ${on.length} tool${on.length > 1 ? 's' : ''} for what’s new since ${lastCatchUpWords(since) ?? 'your last catch-up'}`
                    : `Reads the last 3 days of ${on.length} tool${on.length > 1 ? 's' : ''}`}
            </span>
            <NotNow onClick={onSkip} />
          </div>
        </>
      }
      stage={
        <div className="relative -m-6 self-stretch justify-self-stretch" aria-hidden>
          {pinned.map((t, k) => (
            <Pin
              key={toolKey(t.connector)}
              tool={t}
              at={pinSpot(k, pinned.length)}
              on={isOn(t)}
              delayMs={k * WAKE_STAGGER_MS}
            />
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
  tool,
  on,
  connectorsHome,
  onToggle,
  onConnect,
}: {
  /** null while the first pre-flight hasn't answered: one placeholder row. */
  tool: ConnectorCheck | null;
  on: boolean;
  connectorsHome: string;
  onToggle: () => void;
  onConnect: () => void;
}) {
  const state = tool?.state ?? null;
  const name = tool?.connector ?? 'Your tools';
  const github = tool?.known === 'github';
  const status =
    state === null
      ? 'Looking…'
      : state === 'connected'
        ? on
          ? github
            ? 'Signed in through gh'
            : 'Connected'
          : 'Left out'
        : github
          ? 'Sign in to gh again'
          : `Reconnect in ${connectorsHome}`;

  return (
    <div
      className={cn(
        'grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[11px] rounded-[10px] px-2 py-1.5 transition-[background-color,opacity] duration-300',
        state === null && 'opacity-35',
        state === 'connected' && on && 'bg-bg-2',
        state === 'connected' && !on && 'opacity-55'
      )}
      data-testid={tool ? `connect-row-${toolKey(tool.connector)}` : 'connect-row-checking'}
      data-state={state ?? 'checking'}
    >
      <span
        className={cn(
          'grid size-7 place-items-center rounded-lg',
          state === 'connected' && on ? 'bg-bg-1' : 'bg-bg-2',
          state === 'needs_auth' && 'grayscale-[0.9]'
        )}
      >
        {tool && <ToolMark known={tool.known} name={tool.connector} size={16} />}
      </span>
      <div className="min-w-0">
        <span className="block truncate text-ui font-medium text-text-primary">{name}</span>
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
            id={`connect-${toolKey(name)}`}
            label={`Read ${name}`}
            checked={on}
            onToggle={onToggle}
          />
        )}
        {state === 'needs_auth' && (
          <button
            type="button"
            onClick={onConnect}
            className="text-meta text-accent hover:opacity-80"
            data-testid={`connect-open-${toolKey(name)}`}
          >
            Reconnect ↗
          </button>
        )}
      </span>
    </div>
  );
}

/** A tool on the stage: its mark, name and whether Rig reads it, on glass over its tiles. */
function Pin({
  tool,
  at,
  on,
  delayMs,
}: {
  tool: ConnectorCheck;
  at: { x: number; y: number };
  on: boolean;
  delayMs: number;
}) {
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
      data-testid={`connect-pin-${toolKey(tool.connector)}`}
    >
      <div
        className={cn(
          'fr-pin fr-in gap-[9px] rounded-full py-[7px] pr-[13px] pl-2 transition-opacity duration-300',
          !on && 'opacity-40'
        )}
        style={{ animationDelay: `${delayMs}ms` }}
      >
        <span className="grid size-[26px] place-items-center rounded-full bg-bg-1">
          <ToolMark known={tool.known} name={tool.connector} size={15} />
        </span>
        <span className="text-left">
          <b className="block max-w-[160px] truncate text-sm leading-tight font-medium text-text-primary">
            {tool.connector}
          </b>
          <span className="block text-xs leading-snug text-text-secondary">
            {on ? 'Connected' : 'Left out'}
          </span>
        </span>
      </div>
    </div>
  );
}
