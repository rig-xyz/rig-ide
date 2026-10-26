import { useSyncExternalStore } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { FirstRunStepId } from '@shared/rig/first-run';
import type { FirstRunConnector } from '../env';
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
  /** The tools the simulated agent reaches. */
  connectors: FirstRunConnector[];
};

/** The four kinds of arrival `deriveFirstRun` tells apart, one click each. */
export const FIRST_RUN_CASES: { id: string; label: string; simulation: FirstRunSimulation }[] = [
  {
    id: 'new',
    label: 'New install',
    simulation: {
      rig: 'new',
      agent: 'missing',
      user: 'new',
      connectors: ['slack', 'linear', 'github'],
    },
  },
  {
    id: 'returning-signed-out',
    label: 'Returning, signed out',
    simulation: {
      rig: 'signedOut',
      agent: 'ready',
      user: 'existing',
      connectors: ['slack', 'linear', 'github'],
    },
  },
  {
    id: 'returning-signed-in',
    label: 'Returning, signed in',
    simulation: {
      rig: 'signedIn',
      agent: 'ready',
      user: 'new',
      connectors: ['slack', 'linear', 'github'],
    },
  },
  {
    id: 'existing-upgrading',
    label: 'Existing, upgrading',
    simulation: {
      rig: 'signedIn',
      agent: 'ready',
      user: 'existing',
      connectors: ['slack', 'linear', 'github'],
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
