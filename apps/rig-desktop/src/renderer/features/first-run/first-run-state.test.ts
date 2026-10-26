import { describe, expect, it } from 'vitest';
import { FIRST_RUN_VERSION } from '@shared/rig/first-run';
import { deriveFirstRun, nextStep, resumeStep, shouldShowFirstRun } from './first-run-state';

const ALL = ['welcome', 'setup', 'connect', 'you', 'read', 'firstWin'];
const NO_SETUP = ['welcome', 'connect', 'you', 'read', 'firstWin'];

describe('deriveFirstRun', () => {
  it('a fresh install starts at Welcome, then Set up, as a new user', () => {
    expect(
      deriveFirstRun({ firstRunSeen: 0, hasSeenOnboarding: false, rig: 'new', agent: 'missing' })
    ).toEqual({ steps: ALL, returning: false });
  });

  it('a fresh install whose agent is already ready still sets up a Rig account', () => {
    expect(
      deriveFirstRun({ firstRunSeen: 0, hasSeenOnboarding: false, rig: 'new', agent: 'ready' })
    ).toEqual({ steps: ALL, returning: false });
  });

  it('a returning user who is signed out gets Set up, with the returning copy', () => {
    expect(
      deriveFirstRun({ firstRunSeen: 0, hasSeenOnboarding: true, rig: 'signedOut', agent: 'ready' })
    ).toEqual({ steps: ALL, returning: true });
  });

  it('an expired token counts as returning, and Set up asks to sign in again', () => {
    expect(
      deriveFirstRun({ firstRunSeen: 0, hasSeenOnboarding: false, rig: 'expired', agent: 'ready' })
    ).toEqual({ steps: ALL, returning: true });
  });

  it('a returning signed-in user with a ready agent skips Set up', () => {
    expect(
      deriveFirstRun({ firstRunSeen: 0, hasSeenOnboarding: false, rig: 'signedIn', agent: 'ready' })
    ).toEqual({ steps: NO_SETUP, returning: true });
  });

  it('a signed-in user whose agent runs on an API key still sees Set up', () => {
    expect(
      deriveFirstRun({ firstRunSeen: 0, hasSeenOnboarding: true, rig: 'signedIn', agent: 'apiKey' })
        .steps
    ).toEqual(ALL);
  });

  it('an existing user upgrading to the new Home gets the returning path once', () => {
    const upgrading = deriveFirstRun({
      firstRunSeen: 0,
      hasSeenOnboarding: true,
      rig: 'signedIn',
      agent: 'ready',
    });
    expect(upgrading).toEqual({ steps: NO_SETUP, returning: true });

    const after = deriveFirstRun({
      firstRunSeen: FIRST_RUN_VERSION,
      hasSeenOnboarding: true,
      rig: 'signedIn',
      agent: 'ready',
    });
    expect(after.steps).toEqual([]);
  });

  it('shows nothing once this version has been seen, whatever the account', () => {
    for (const rig of ['new', 'signedOut', 'expired', 'signedIn'] as const) {
      expect(
        deriveFirstRun({
          firstRunSeen: FIRST_RUN_VERSION,
          hasSeenOnboarding: false,
          rig,
          agent: 'missing',
        }).steps
      ).toEqual([]);
    }
  });
});

describe('shouldShowFirstRun', () => {
  it('shows for an older flow version, not for this one or a newer one', () => {
    expect(shouldShowFirstRun(0)).toBe(true);
    expect(shouldShowFirstRun(FIRST_RUN_VERSION)).toBe(false);
    expect(shouldShowFirstRun(FIRST_RUN_VERSION + 1)).toBe(false);
  });
});

describe('resumeStep', () => {
  it('starts at the first step with nothing saved', () => {
    expect(resumeStep(ALL as never, null)).toBe('welcome');
  });

  it('resumes at the saved step', () => {
    expect(resumeStep(ALL as never, { step: 'setup', readStarted: false })).toBe('setup');
  });

  it('goes back to Read once the first read has started', () => {
    expect(resumeStep(ALL as never, { step: 'you', readStarted: true })).toBe('read');
  });

  it('moves past a saved Set up the plan no longer has', () => {
    expect(resumeStep(NO_SETUP as never, { step: 'setup', readStarted: false })).toBe('connect');
  });

  it('has nowhere to go with no steps', () => {
    expect(resumeStep([], { step: 'setup', readStarted: false })).toBeNull();
  });
});

describe('nextStep', () => {
  const builtNow = (step: string) => step === 'welcome' || step === 'setup';

  it('goes to the next built step', () => {
    expect(nextStep(ALL as never, 'welcome', builtNow)).toBe('setup');
  });

  it('skips steps not built yet, and ends at Home after the last built one', () => {
    expect(nextStep(ALL as never, 'setup', builtNow)).toBeNull();
    expect(nextStep(NO_SETUP as never, 'welcome', builtNow)).toBeNull();
  });
});
