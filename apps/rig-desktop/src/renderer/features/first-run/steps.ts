import type { FirstRunStepId } from '@shared/rig/first-run';

/**
 * The first run's steps and which are built. The shell skips a step that
 * isn't built yet, so for now Set up goes straight to Home.
 */
export const FIRST_RUN_STEPS: Record<FirstRunStepId, { label: string; built: boolean }> = {
  welcome: { label: 'Welcome', built: true },
  setup: { label: 'Set up', built: true },
  // ── Placeholders: not built yet (rig/docs/onboarding-spec.md, "Build order").
  // M2: Connect's pre-flight, source toggles and focus re-check, in `./connect/`.
  connect: { label: 'Connect', built: true },
  // M5: the profile pass 1 writes (`rig_profile`), shown and edited.
  you: { label: 'You', built: false },
  // M3: the live log of the first orchestrator pass, in `./read/`.
  read: { label: 'Read', built: true },
  // M4: a real Feed card with a draft and Send, in `./first-win/`.
  firstWin: { label: 'First win', built: true },
};

export function isBuiltStep(step: FirstRunStepId): boolean {
  return FIRST_RUN_STEPS[step].built;
}
