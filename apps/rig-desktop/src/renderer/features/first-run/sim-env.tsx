import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAgentIdentities } from '@renderer/features/chat/use-runnable-agents';
import { rpc } from '@renderer/lib/ipc';
import { FIRST_RUN_VERSION, type FirstRunProgress } from '@shared/rig/first-run';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import { agentRoute, ROUTED_AGENT_ID } from './agent-route';
import { withWatched, type Watching } from './connect/sources';
import { SIM_TOOLS, type FirstRunSimulation } from './debug/first-run-debug';
import {
  type AgentState,
  type FirstRunEnv,
  type RigAccountState,
  type RigSignInState,
} from './env';
import recorded from './read/fixtures/first-run.json';
import { simulatedFirstWin } from './first-win/fixtures';
import { replaySource } from './read/progress-source';

/** How long a simulated browser hop, install or sign-in takes, so the waiting states show. */
const SIGN_IN_MS = 1800;
const INSTALL_MS = 2200;
const PREFLIGHT_MS = 600;
const CONNECT_MS = 1500;
const SIM_EMAIL = 'alex@larkspur.com';
const SIM_NAME = 'Alex Rivera';
const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';

function initialRig(simulation: FirstRunSimulation): RigAccountState {
  return simulation.rig === 'signedIn'
    ? { kind: 'signedIn', email: SIM_EMAIL, name: SIM_NAME, unverified: false }
    : { kind: simulation.rig };
}

function initialAgent(simulation: FirstRunSimulation): AgentState {
  switch (simulation.agent) {
    case 'missing':
      return { kind: 'missing', installCommand: INSTALL_COMMAND };
    case 'signedOut':
      return { kind: 'signedOut' };
    case 'apiKey':
      return { kind: 'apiKey', account: null };
    case 'ready':
      return { kind: 'ready', account: SIM_EMAIL };
  }
}

/**
 * The first run against a made-up account and agent (the debug harness).
 * Its sign-ins and install succeed after a short wait; nothing real is read
 * or changed, apart from marking the first run seen when it's finished.
 */
export function SimulatedFirstRunEnv({
  simulation,
  children,
}: {
  simulation: FirstRunSimulation;
  children: (env: FirstRunEnv) => ReactNode;
}) {
  const identities = useAgentIdentities();
  const route = agentRoute(ROUTED_AGENT_ID);
  const [rig, setRig] = useState<RigAccountState>(() => initialRig(simulation));
  const [agent, setAgent] = useState<AgentState>(() => initialAgent(simulation));
  const [rigSignIn, setRigSignIn] = useState<RigSignInState>({
    phase: 'idle',
    url: null,
    error: null,
  });
  const [progress, setProgress] = useState<FirstRunProgress | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // What the simulated agent reaches, and what the person chose to watch.
  const connectors = useRef(simulation.connectors);
  const watching = useRef<Watching>({});
  // Someone Rig has read for: caught up since two days ago, not a first read of the last three days.
  const since = useMemo(
    () => (simulation.user === 'existing' ? new Date(Date.now() - 2 * 86_400_000).toISOString() : null),
    [simulation.user]
  );
  // The recorded first run, played back: a simulation never starts a real one.
  const readSource = useMemo(
    () =>
      replaySource(
        (recorded as OrchProgressEvent[]).map((e) => (e.kind === 'start' && since ? { ...e, since } : e))
      ),
    [since]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const later = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const env: FirstRunEnv = {
    user: { firstRunSeen: 0, hasSeenOnboarding: simulation.user === 'existing', progress },
    rig,
    rigSignIn,
    agent,
    agentInfo: {
      name: identities.get(route.id)?.name ?? 'Claude Code',
      icon: identities.get(route.id)?.icon ?? null,
      route,
    },
    recheck: () => {},
    startRigSignIn: () => {
      setRigSignIn({
        phase: 'waiting',
        url: 'https://userig.xyz/auth/device?code=SIMULATED',
        error: null,
      });
      later(SIGN_IN_MS, () => {
        setRigSignIn({ phase: 'idle', url: null, error: null });
        setRig({ kind: 'signedIn', email: SIM_EMAIL, name: SIM_NAME, unverified: false });
      });
    },
    cancelRigSignIn: () => setRigSignIn({ phase: 'idle', url: null, error: null }),
    installAgent: () => {
      setAgent({ kind: 'installing' });
      later(INSTALL_MS, () => setAgent({ kind: 'signedOut' }));
    },
    signInAgent: () => {
      setAgent({ kind: 'signingIn' });
      later(SIGN_IN_MS, () => setAgent({ kind: 'ready', account: SIM_EMAIL }));
    },
    preflight: () =>
      new Promise((resolve) =>
        later(PREFLIGHT_MS, () =>
          resolve(
            SIM_TOOLS.flatMap(({ connector, known }) => {
              const state = connectors.current[connector];
              return state ? [{ connector, known, state }] : [];
            })
          )
        )
      ),
    readWatching: () => Promise.resolve({ ...watching.current }),
    setWatching: (connector, on) => {
      watching.current = withWatched(watching.current, connector, on);
      return Promise.resolve();
    },
    // As if the person connected it (or, asked to connect more, Notion) in claude.ai and came back.
    openConnect: (connector = 'Notion') =>
      later(CONNECT_MS, () => {
        connectors.current = { ...connectors.current, [connector]: 'connected' };
        window.dispatchEvent(new Event('focus'));
      }),
    readSource,
    catchUpSince: () => Promise.resolve(since),
    ensureHome: () => {},
    firstWin: simulatedFirstWin(later),
    saveProgress: setProgress,
    trackStep: () => {},
    finish: () =>
      void rpc.rig.settings.set({ firstRunSeen: FIRST_RUN_VERSION, firstRunProgress: null }),
    overlay: null,
  };

  return <>{children(env)}</>;
}
