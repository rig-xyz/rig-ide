import { describe, expect, it } from 'vitest';
import { agentNeedsSignIn, cliLoginMethod, deriveAgentAuthRowState, type CliLoginMethod } from './agent-auth-state';

const CLI_LOGIN: CliLoginMethod = { kind: 'cli-login', id: 'login', name: 'Login', args: [] };
const API_KEY = {
  kind: 'api-key' as const,
  id: 'api-key',
  name: 'API key',
  envVars: [{ name: 'FOO_API_KEY', label: 'FOO API key' }],
};

describe('cliLoginMethod', () => {
  it('no auth support at all — null', () => {
    expect(cliLoginMethod({ auth: { kind: 'none' } })).toBeNull();
  });

  it('supported, but only an api-key method — null (no CLI login to drive)', () => {
    expect(cliLoginMethod({ auth: { kind: 'supported', methods: [API_KEY] } })).toBeNull();
  });

  it('supported with a cli-login method — that method', () => {
    expect(cliLoginMethod({ auth: { kind: 'supported', methods: [API_KEY, CLI_LOGIN] } })).toEqual(CLI_LOGIN);
  });
});

describe('deriveAgentAuthRowState', () => {
  const base = {
    loginMethod: CLI_LOGIN,
    signedInOverride: false,
    probeStatus: 'success' as const,
    probeData: undefined as AgentAuthStatusLike | null | undefined,
  };

  it('no login method — noAuthSupport, regardless of probe state (the current "installed" badge stays)', () => {
    expect(
      deriveAgentAuthRowState({ ...base, loginMethod: null, probeStatus: 'pending' })
    ).toEqual({ kind: 'noAuthSupport' });
  });

  it('probe still in flight (no data yet) — probing, never a guessed not-signed-in', () => {
    expect(deriveAgentAuthRowState({ ...base, probeStatus: 'pending', probeData: undefined })).toEqual({
      kind: 'probing',
    });
  });

  it('probe resolved authenticated with an account — signedIn, carrying the account', () => {
    expect(
      deriveAgentAuthRowState({
        ...base,
        probeData: { kind: 'authenticated', account: 'dylan@userig.xyz' },
      })
    ).toEqual({ kind: 'signedIn', account: 'dylan@userig.xyz' });
  });

  it('probe resolved authenticated with no account field — signedIn, account null (never invented)', () => {
    expect(deriveAgentAuthRowState({ ...base, probeData: { kind: 'authenticated' } })).toEqual({
      kind: 'signedIn',
      account: null,
    });
  });

  it('probe resolved unauthenticated — notSignedIn', () => {
    expect(deriveAgentAuthRowState({ ...base, probeData: { kind: 'unauthenticated' } })).toEqual({
      kind: 'notSignedIn',
    });
  });

  it('probe resolved unknown — notSignedIn (the actionable default, not a fourth UI state)', () => {
    expect(deriveAgentAuthRowState({ ...base, probeData: { kind: 'unknown' } })).toEqual({
      kind: 'notSignedIn',
    });
  });

  it('probe errored with no data — notSignedIn, not stuck probing forever', () => {
    expect(deriveAgentAuthRowState({ ...base, probeStatus: 'error', probeData: null })).toEqual({
      kind: 'notSignedIn',
    });
  });

  it('signedInOverride flips the row immediately even before the probe refetch lands', () => {
    expect(
      deriveAgentAuthRowState({ ...base, signedInOverride: true, probeStatus: 'pending', probeData: undefined })
    ).toEqual({ kind: 'signedIn', account: null });
  });

  it('signedInOverride is superseded by a freshly-landed probe account, once it resolves', () => {
    expect(
      deriveAgentAuthRowState({
        ...base,
        signedInOverride: true,
        probeData: { kind: 'authenticated', account: 'dylan@userig.xyz' },
      })
    ).toEqual({ kind: 'signedIn', account: 'dylan@userig.xyz' });
  });
});

describe('agentNeedsSignIn', () => {
  const base = {
    runnable: true,
    loginMethod: CLI_LOGIN as CliLoginMethod | null,
    probeData: { kind: 'authenticated' } as AgentAuthStatusLike | null | undefined,
    failedOnSignIn: false,
  };

  it('signed in and no failed run: no warning', () => {
    expect(agentNeedsSignIn(base)).toBe(false);
  });

  it('a definite unauthenticated probe: needs sign-in', () => {
    expect(agentNeedsSignIn({ ...base, probeData: { kind: 'unauthenticated' } })).toBe(true);
  });

  it('an unknown, failed or pending probe is never a false alarm', () => {
    expect(agentNeedsSignIn({ ...base, probeData: { kind: 'unknown' } })).toBe(false);
    expect(agentNeedsSignIn({ ...base, probeData: null })).toBe(false);
    expect(agentNeedsSignIn({ ...base, probeData: undefined })).toBe(false);
  });

  it('a run that failed on its sign-in counts even while the probe still says signed in', () => {
    expect(agentNeedsSignIn({ ...base, failedOnSignIn: true })).toBe(true);
  });

  it('not runnable here, or no CLI sign-in to offer: never', () => {
    expect(agentNeedsSignIn({ ...base, runnable: false, failedOnSignIn: true })).toBe(false);
    expect(agentNeedsSignIn({ ...base, loginMethod: null, probeData: { kind: 'unauthenticated' } })).toBe(false);
  });
});

type AgentAuthStatusLike =
  | { kind: 'authenticated'; account?: string }
  | { kind: 'unauthenticated'; message?: string }
  | { kind: 'unknown'; message?: string };
