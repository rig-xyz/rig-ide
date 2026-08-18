import { describe, expect, it } from 'vitest';
import {
  deriveOnboardingSteps,
  hasCliLogin,
  hasInstalledAgent,
  onboardingAgents,
  preferredInstallOptions,
} from './onboarding-state';

describe('deriveOnboardingSteps', () => {
  it('shows nothing once onboarding has already been seen, regardless of sign-in state', () => {
    expect(deriveOnboardingSteps({ hasSeenOnboarding: true, signedIn: false })).toEqual([]);
    expect(deriveOnboardingSteps({ hasSeenOnboarding: true, signedIn: true })).toEqual([]);
  });

  it('a fresh, signed-out install sees both steps, agents first', () => {
    expect(deriveOnboardingSteps({ hasSeenOnboarding: false, signedIn: false })).toEqual([
      'agents',
      'signIn',
    ]);
  });

  it('a fresh install that is somehow already signed in skips the redundant sign-in step', () => {
    expect(deriveOnboardingSteps({ hasSeenOnboarding: false, signedIn: true })).toEqual(['agents']);
  });
});

describe('hasInstalledAgent', () => {
  it('true when at least one agent is available', () => {
    expect(hasInstalledAgent([{ status: 'missing' }, { status: 'available' }])).toBe(true);
  });

  it('false when every agent is missing or errored', () => {
    expect(hasInstalledAgent([{ status: 'missing' }, { status: 'error' }])).toBe(false);
  });

  it('false for undefined/empty — never blocks on an unloaded query as if it were success', () => {
    expect(hasInstalledAgent(undefined)).toBe(false);
    expect(hasInstalledAgent([])).toBe(false);
  });
});

describe('onboardingAgents', () => {
  const claude = { id: 'claude', name: 'Claude Code' };
  const codex = { id: 'codex', name: 'Codex' };
  const other = { id: 'other', name: 'Some Other Agent' };

  it('narrows to claude/codex, alphabetically, when both are present', () => {
    expect(onboardingAgents([other, codex, claude])).toEqual([claude, codex]);
  });

  it('falls back to the full list when neither recommended id is present', () => {
    expect(onboardingAgents([other])).toEqual([other]);
  });

  it('is empty for an empty/undefined list', () => {
    expect(onboardingAgents([])).toEqual([]);
    expect(onboardingAgents(undefined)).toEqual([]);
  });
});

describe('preferredInstallOptions', () => {
  it('narrows to the recommended option(s) when any exist', () => {
    const options = [
      { method: 'curl', recommended: true },
      { method: 'homebrew' },
    ];
    expect(preferredInstallOptions(options)).toEqual([{ method: 'curl', recommended: true }]);
  });

  it('shows everything when nothing is marked recommended', () => {
    const options: { method: string; recommended?: boolean }[] = [
      { method: 'npm' },
      { method: 'homebrew' },
    ];
    expect(preferredInstallOptions(options)).toEqual(options);
  });

  it('is empty for an empty list', () => {
    expect(preferredInstallOptions([])).toEqual([]);
  });
});

describe('hasCliLogin', () => {
  it('true when the auth descriptor is supported', () => {
    expect(hasCliLogin({ auth: { kind: 'supported' } })).toBe(true);
  });

  it('false when there is no auth flow at all', () => {
    expect(hasCliLogin({ auth: { kind: 'none' } })).toBe(false);
  });
});
