import { describe, expect, it } from 'vitest';
import type { ProbeResult } from './runtime';
import { agentResolveStatus } from './descriptor-from-provider';

/**
 * `agentResolveStatus` is the `resolveStatus` every agent gets by default
 * (see its own doc comment) — it, not `host-dependency-manager.ts`'s generic
 * fallback, is what actually decides every agent's status. These are the
 * regression tests the "runnable beats resolvable" fix (a4898a8) should have
 * had: that fix only touched the generic fallback, which no agent-category
 * dependency ever reaches, so it left this function's pre-fix behavior —
 * 'available' the instant a path resolves, without reading the probe result
 * at all — in place for every agent (goose included; see the rig-tasks-spike
 * report for the live repro: an unrelated `goose` binary already on PATH,
 * e.g. pressly/goose, made the mention menu list Goose as available).
 */

function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return { command: 'agent', path: '/usr/local/bin/agent', stdout: '', stderr: '', exitCode: 0, timedOut: false, ...overrides };
}

describe('agentResolveStatus', () => {
  it('is available when a resolved path actually runs (exit 0)', () => {
    expect(agentResolveStatus(probe({ exitCode: 0, stdout: 'agent 1.2.3' }))).toBe('available');
  });

  it('is error, not available, when a resolved path exits non-zero', () => {
    // The exact codex-wrapper-that-immediately-throws case the sibling fix
    // (a4898a8) was written for — except that fix never reached this
    // function, so it kept reporting 'available' here regardless.
    expect(agentResolveStatus(probe({ exitCode: 1, stderr: 'command not found' }))).toBe('error');
  });

  it('is available when a slow-starting probe timed out but already printed output', () => {
    expect(agentResolveStatus(probe({ exitCode: null, timedOut: true, stdout: 'star' }))).toBe(
      'available'
    );
  });

  it('is error when a resolved path times out with no output at all', () => {
    expect(agentResolveStatus(probe({ exitCode: null, timedOut: true, stdout: '' }))).toBe(
      'error'
    );
  });

  it('falls back to the no-path rules when nothing resolved — unchanged by this fix', () => {
    expect(agentResolveStatus(probe({ path: null, exitCode: null }))).toBe('missing');
    expect(agentResolveStatus(probe({ path: null, exitCode: 127 }))).toBe('error');
  });
});
