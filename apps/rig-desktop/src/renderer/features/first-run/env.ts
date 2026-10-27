import type { ReactNode } from 'react';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import type { FirstRunProgress } from '@shared/rig/first-run';
import type { AgentRoute } from './agent-route';
import type { ProgressSource } from './read/progress-source';

/**
 * Everything the first run sees of the world and can do to it, in one place.
 * `real-env.tsx` reads the real token, agent and settings; `sim-env.tsx`
 * makes them up for the debug harness, without touching any of them. Flow
 * code only ever talks to this, so it never asks whether it's a simulation.
 */
export interface FirstRunEnv {
  /** What this install remembers of earlier runs. */
  user: {
    /** The first run's version this install finished (`FIRST_RUN_VERSION`), 0 before any. */
    firstRunSeen: number;
    hasSeenOnboarding: boolean;
    /** Where an unfinished first run stopped. */
    progress: FirstRunProgress | null;
  };
  rig: RigAccountState;
  rigSignIn: RigSignInState;
  agent: AgentState;
  agentInfo: AgentInfo;
  /** Asks again past every cache: on entering Set up, and on window focus. */
  recheck(): void;
  startRigSignIn(): void;
  cancelRigSignIn(): void;
  installAgent(): void;
  signInAgent(): void;
  /** Which of the person's tools their agent reaches. `null` until Connect's pre-flight is built (M2). */
  preflight(): Promise<ConnectorCheck[] | null>;
  /** Where the Read step's progress comes from: the real first run, or a recorded one in a simulation. */
  readSource: ProgressSource;
  saveProgress(progress: FirstRunProgress): void;
  /** Done: don't show this first run again. */
  finish(): void;
  /** What the environment shows over the flow, such as the agent's sign-in terminal. */
  overlay: ReactNode;
}

export type RigAccountState =
  | { kind: 'checking' }
  | { kind: 'new' }
  | { kind: 'signedOut' }
  | { kind: 'expired' }
  | {
      kind: 'signedIn';
      email: string | null;
      name: string | null;
      /** The relay couldn't be reached to check the token, so this rests on the token alone. */
      unverified: boolean;
    };

export type RigSignInState = {
  phase: 'idle' | 'starting' | 'waiting';
  /** The sign-in page, once `rig login` has printed it. */
  url: string | null;
  error: string | null;
};

export type AgentState =
  | { kind: 'checking' }
  | { kind: 'missing'; installCommand: string | null }
  | { kind: 'installing' }
  | { kind: 'signedOut' }
  | { kind: 'signingIn' }
  | { kind: 'apiKey'; account: string | null }
  | { kind: 'ready'; account: string | null };

export type AgentInfo = { name: string; icon: AgentIconAsset | null; route: AgentRoute };

export const FIRST_RUN_CONNECTORS = [
  'slack',
  'linear',
  'github',
  'gmail',
  'calendar',
  'notion',
] as const;
export type FirstRunConnector = (typeof FIRST_RUN_CONNECTORS)[number];

export type ConnectorCheck = {
  connector: FirstRunConnector;
  state: 'connected' | 'needs_auth' | 'missing';
};
