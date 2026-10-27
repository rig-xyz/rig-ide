/**
 * The first run (rig/docs/onboarding-spec.md): its steps, its version, and
 * the progress kept in settings so a quit resumes where it stopped.
 */

/**
 * The first run's steps, in order. Home is where it ends, not a step. Not
 * every one is built yet: `renderer/features/first-run/steps.ts` says which.
 */
export const FIRST_RUN_STEP_IDS = [
  'welcome',
  'setup',
  'connect',
  'you',
  'read',
  'firstWin',
] as const;
export type FirstRunStepId = (typeof FIRST_RUN_STEP_IDS)[number];

/**
 * The flow's version. `firstRunSeen` below it shows the first run again, so
 * raising this shows a changed flow once to everyone who saw the old one.
 */
export const FIRST_RUN_VERSION = 1;

/** Where a first run in progress stopped. */
export type FirstRunProgress = {
  step: FirstRunStepId;
  /** The first read (pass 1) has started, so a resume goes back to Read, not before it. */
  readStarted: boolean;
};

export function isFirstRunStepId(value: unknown): value is FirstRunStepId {
  return typeof value === 'string' && (FIRST_RUN_STEP_IDS as readonly string[]).includes(value);
}

export function normalizeFirstRunProgress(value: unknown): FirstRunProgress | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isFirstRunStepId(raw.step)) return null;
  return { step: raw.step, readStarted: raw.readStarted === true };
}

/** The tools Connect looks for, in the order it lists them. */
export const FIRST_RUN_CONNECTORS = [
  'slack',
  'linear',
  'github',
  'gmail',
  'calendar',
  'notion',
] as const;
export type FirstRunConnector = (typeof FIRST_RUN_CONNECTORS)[number];

/**
 * Where one tool stands for the person's agent (`rpc.rig.firstRun.preflight`):
 * reachable, there but needing the person to sign in again, or not there.
 */
export type ConnectorCheck = {
  connector: FirstRunConnector;
  state: 'connected' | 'needs_auth' | 'missing';
};
