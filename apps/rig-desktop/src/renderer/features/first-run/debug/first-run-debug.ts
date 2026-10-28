import { useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type {
  ConnectorCheck,
  FirstRunConnector,
  FirstRunStepId,
  KnownTool,
} from '@shared/rig/first-run';
import type { AgentReadiness, RigAccountKind } from '../first-run-state';

/**
 * The first run's debug harness (dev builds, or Settings › Advanced › Debug
 * mode): replay it, and simulate any account and agent without signing out
 * or making accounts. A simulation only changes what the flow sees
 * (`sim-env.tsx`); the real token, `~/.claude` and agent are never touched.
 */

export type FirstRunSimulation = {
  rig: RigAccountKind;
  agent: AgentReadiness;
  /** `existing` has seen the old onboarding: the returning path. */
  user: 'new' | 'existing';
  /** What the simulated agent reaches: a tool that's absent is not connected. */
  connectors: SimulatedConnectors;
};

/** What the simulated agent reaches, by the tool's name in Claude's list; a tool that's absent isn't there. */
export type SimulatedConnectors = Partial<Record<FirstRunConnector, ConnectorCheck['state']>>;

/**
 * The tools a simulated Claude can have, recorded from a real `claude mcp list` (and `gh`): a few
 * Rig knows, and some it doesn't, which show a neutral mark. Notion is the one to connect more.
 */
export const SIM_TOOLS: readonly { connector: FirstRunConnector; known: KnownTool | null }[] = [
  { connector: 'Slack', known: 'slack' },
  { connector: 'Linear', known: 'linear' },
  { connector: 'Granola', known: 'granola' },
  { connector: 'Google Drive', known: null },
  { connector: 'Google Calendar', known: 'calendar' },
  { connector: 'Gmail', known: 'gmail' },
  { connector: 'Atlassian Rovo', known: null },
  { connector: 'Ramp', known: null },
  { connector: 'GitHub', known: 'github' },
  { connector: 'Notion', known: 'notion' },
];

/** What the presets' agent reaches, as recorded: Ramp asks to sign in again; Notion isn't there. */
const USUAL_TOOLS: SimulatedConnectors = {
  Slack: 'connected',
  Linear: 'connected',
  Granola: 'connected',
  'Google Drive': 'connected',
  'Google Calendar': 'connected',
  Gmail: 'connected',
  'Atlassian Rovo': 'connected',
  Ramp: 'needs_auth',
  GitHub: 'connected',
};

/** A connector chip's next state: connected, then needing re-auth, then not there. */
export function nextConnectorState(
  connectors: SimulatedConnectors,
  connector: FirstRunConnector
): SimulatedConnectors {
  const { [connector]: now, ...rest } = connectors;
  if (now === undefined) return { ...rest, [connector]: 'connected' };
  if (now === 'connected') return { ...rest, [connector]: 'needs_auth' };
  return rest;
}

/** The four kinds of arrival `deriveFirstRun` tells apart, one click each. */
export const FIRST_RUN_CASES: { id: string; label: string; simulation: FirstRunSimulation }[] = [
  {
    id: 'new',
    label: 'New install',
    simulation: {
      rig: 'new',
      agent: 'missing',
      user: 'new',
      connectors: USUAL_TOOLS,
    },
  },
  {
    id: 'returning-signed-out',
    label: 'Returning, signed out',
    simulation: {
      rig: 'signedOut',
      agent: 'ready',
      user: 'existing',
      connectors: USUAL_TOOLS,
    },
  },
  {
    id: 'returning-signed-in',
    label: 'Returning, signed in',
    simulation: {
      rig: 'signedIn',
      agent: 'ready',
      user: 'new',
      connectors: USUAL_TOOLS,
    },
  },
  {
    id: 'existing-upgrading',
    label: 'Existing, upgrading',
    simulation: {
      rig: 'signedIn',
      agent: 'ready',
      user: 'existing',
      connectors: USUAL_TOOLS,
    },
  },
];

export const RIG_STATES: { id: RigAccountKind; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'signedOut', label: 'Signed out' },
  { id: 'signedIn', label: 'Signed in' },
  { id: 'expired', label: 'Token expired' },
];

export const AGENT_STATES: { id: AgentReadiness; label: string }[] = [
  { id: 'missing', label: 'Missing' },
  { id: 'signedOut', label: 'Not signed in' },
  { id: 'apiKey', label: 'API key' },
  { id: 'ready', label: 'Ready' },
];

type DebugState = {
  simulation: FirstRunSimulation | null;
  /** Where a (re)started run opens; Welcome when null. */
  startAt: FirstRunStepId | null;
  /** Bumped on every start, so the flow remounts fresh. */
  run: number;
};

let state: DebugState = { simulation: null, startAt: null, run: 0 };
const listeners = new Set<() => void>();

function emit(next: DebugState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFirstRunDebug(): DebugState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  );
}

/** Whether the harness is offered: always in dev builds, else with Debug mode on. */
export function firstRunDebugAvailable(debugMode: boolean): boolean {
  return import.meta.env.DEV || debugMode;
}

/**
 * Starts the first run again: clears that it was seen and where it stopped,
 * so App opens it. With a simulation, the flow sees that instead of the real
 * account and agent.
 */
export function replayFirstRun(
  simulation: FirstRunSimulation | null = null,
  startAt: FirstRunStepId | null = null
): Promise<unknown> {
  emit({ simulation, startAt, run: state.run + 1 });
  return rpc.rig.settings.set({ firstRunSeen: 0, firstRunProgress: null });
}

/** Back to the real account and agent, from the start. */
export function stopSimulating(): void {
  emit({ simulation: null, startAt: null, run: state.run + 1 });
}

/** Called when a first run finishes, so the next replay starts clean. */
export function clearFirstRunDebug(): void {
  if (state.simulation || state.startAt) emit({ simulation: null, startAt: null, run: state.run });
}
