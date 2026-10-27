/**
 * Who sees which steps of the first run (rig/docs/onboarding-spec.md, Step
 * 0). Pure, so each kind of arrival is a unit test, and the shell
 * (`first-run.tsx`) only feeds it what `FirstRunEnv` sees.
 */

import {
  FIRST_RUN_STEP_IDS,
  FIRST_RUN_VERSION,
  type FirstRunProgress,
  type FirstRunStepId,
} from '@shared/rig/first-run';

/**
 * The Rig account as Set up sees it. `new`: no account on this Mac and no
 * sign it was ever used here. `signedOut`: no token, but Rig was used here
 * before. `expired`: a token the relay turned down (`GET /v1/me` 401).
 */
export type RigAccountKind = 'new' | 'signedOut' | 'expired' | 'signedIn';

/**
 * The agent the catch-up runs on, as Set up sees it. `apiKey` is signed in
 * but can't reach the person's connectors; `ready` can.
 */
export type AgentReadiness = 'missing' | 'signedOut' | 'apiKey' | 'ready';

export type FirstRunPlan = {
  /** In order; empty when the first run has been seen. Home follows the last. */
  steps: FirstRunStepId[];
  /** Has used Rig before: shorter copy, and a prefilled You step. */
  returning: boolean;
};

export function shouldShowFirstRun(firstRunSeen: number): boolean {
  return firstRunSeen < FIRST_RUN_VERSION;
}

/**
 * Welcome always comes first. Set up drops out only when both of its rows
 * would already show a check: a token the relay accepts, and an agent that
 * reaches the person's connectors.
 */
export function deriveFirstRun(input: {
  firstRunSeen: number;
  hasSeenOnboarding: boolean;
  rig: RigAccountKind;
  agent: AgentReadiness;
}): FirstRunPlan {
  const returning = input.hasSeenOnboarding || input.rig !== 'new';
  if (!shouldShowFirstRun(input.firstRunSeen)) return { steps: [], returning };
  const setUp = input.rig === 'signedIn' && input.agent === 'ready';
  return {
    steps: FIRST_RUN_STEP_IDS.filter((step) => step !== 'setup' || !setUp),
    returning,
  };
}

/**
 * Where to pick up a first run that was quit part way. Once the first read
 * has started it goes back to Read; a saved step the plan no longer has
 * (Set up, finished elsewhere since) moves on to the next one it does.
 */
export function resumeStep(
  steps: readonly FirstRunStepId[],
  progress: FirstRunProgress | null
): FirstRunStepId | null {
  if (steps.length === 0) return null;
  if (!progress) return steps[0]!;
  const target = progress.readStarted && steps.includes('read') ? 'read' : progress.step;
  if (steps.includes(target)) return target;
  const after = FIRST_RUN_STEP_IDS.slice(FIRST_RUN_STEP_IDS.indexOf(target) + 1);
  return after.find((step) => steps.includes(step)) ?? steps[0]!;
}

/** The next step after `current` that `built` can show, or `null` for Home. */
export function nextStep(
  steps: readonly FirstRunStepId[],
  current: FirstRunStepId,
  built: (step: FirstRunStepId) => boolean
): FirstRunStepId | null {
  const index = steps.indexOf(current);
  return steps.slice(index + 1).find(built) ?? null;
}
