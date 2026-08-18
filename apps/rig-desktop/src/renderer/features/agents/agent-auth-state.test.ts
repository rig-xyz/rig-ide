import { describe, expect, it } from 'vitest';
import { cliLoginMethod, deriveAgentAuthRowState, type CliLoginMethod } from './agent-auth-state';

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

type AgentAuthStatusLike =
  | { kind: 'authenticated'; account?: string }
  | { kind: 'unauthenticated'; message?: string }
  | { kind: 'unknown'; message?: string };
