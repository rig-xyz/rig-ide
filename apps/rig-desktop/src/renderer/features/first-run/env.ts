import type { ReactNode } from 'react';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import type { ConnectorCheck, FirstRunConnector, FirstRunProgress } from '@shared/rig/first-run';
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
  /** Which of the person's tools their agent reaches, read fresh each time (Connect's pre-flight). */
  preflight(): Promise<ConnectorCheck[]>;
  /** Which tools Rig already watches (true) or was told to leave out (false); a tool with neither is absent. */
  readWatching(): Promise<Partial<Record<FirstRunConnector, boolean>>>;
  /** Watch a tool or leave it out: what the first read, and every read after it, goes through. */
  setWatching(connector: FirstRunConnector, on: boolean): Promise<void>;
  /** Opens where the agent's tools are connected (claude.ai's connector settings), or how to, for GitHub. */
  openConnect(connector: FirstRunConnector): void;
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
