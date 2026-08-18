import { describe, expect, it } from 'vitest';
import { isPresslyGooseOutput, resolveGooseStatus } from './resolve-status';

function probe(overrides: Partial<{ stdout: string; stderr: string; exitCode: number | null }> = {}) {
  return {
    command: 'goose',
    path: '/usr/local/bin/goose',
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

describe('isPresslyGooseOutput', () => {
  it('recognizes pressly/goose\'s real --version output ("goose version: <ver>")', () => {
    expect(isPresslyGooseOutput(probe({ stdout: 'goose version: v3.24.1\n' }))).toBe(true);
  });

  it('recognizes the dev-build variant ("goose version: (devel)")', () => {
    expect(isPresslyGooseOutput(probe({ stdout: 'goose version: (devel)\n' }))).toBe(true);
  });

  it('does not flag this agent\'s real clap output ("goose <semver>", no "version" word)', () => {
    expect(isPresslyGooseOutput(probe({ stdout: 'goose 1.4.2\n' }))).toBe(false);
  });

  it('checks stderr too, in case a build prints its banner there', () => {
    expect(isPresslyGooseOutput(probe({ stdout: '', stderr: 'goose version: v3.0.0\n' }))).toBe(true);
  });
});

describe('resolveGooseStatus', () => {
  it('reports the impostor as missing, not available or error, however cleanly it exits', () => {
    expect(resolveGooseStatus(probe({ stdout: 'goose version: v3.24.1\n', exitCode: 0 }))).toBe('missing');
  });

  it('falls through to the normal agent status logic for the real agent', () => {
    expect(resolveGooseStatus(probe({ stdout: 'goose 1.4.2\n', exitCode: 0 }))).toBe('available');
  });
});
