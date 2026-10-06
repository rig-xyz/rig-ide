import { describe, expect, it } from 'vitest';
import {
  APPLY_ERROR_FRESH_MS,
  applyErrorKind,
  OFFLINE_LONG_MS,
  syncProblemsFrom,
} from './sync-problems';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const running = { state: 'running' } as const;

describe('syncProblemsFrom', () => {
  it('a folder that should sync but has no sync process is daemon_stalled; a failed start is other', () => {
    expect(
      syncProblemsFrom({ health: { state: 'stopped' }, tapd: null, offlineSince: null, now: NOW })
    ).toEqual([{ reason: 'daemon_stalled' }]);
    expect(
      syncProblemsFrom({
        health: { state: 'error', message: 'boom' },
        tapd: null,
        offlineSince: null,
        now: NOW,
      })
    ).toEqual([{ reason: 'other' }]);
  });

  it('a pause someone chose is not a problem; one left over from signing out is', () => {
    const paused = (reason: string | null) =>
      syncProblemsFrom({
        health: { state: 'paused', pausedAt: null, reason },
        tapd: null,
        offlineSince: null,
        now: NOW,
      });
    expect(paused(null)).toEqual([]);
    expect(paused('deleted')).toEqual([]);
    expect(paused('signedOut')).toEqual([{ reason: 'paused_unexpectedly' }]);
  });

  it('a fresh apply error, with a short code and never the file', () => {
    const problems = syncProblemsFrom({
      health: running,
      tapd: {
        lastApplyError: {
          op: 'write',
          reason: "EACCES: permission denied, open '/Users/dylan/Rig/Plans/q3.md'",
          at: new Date(NOW - 60_000).toISOString(),
        },
      },
      offlineSince: null,
      now: NOW,
    });
    expect(problems).toEqual([{ reason: 'apply_error', apply_error_kind: 'eacces' }]);
  });

  it('an apply error older than a day is history', () => {
    const at = new Date(NOW - APPLY_ERROR_FRESH_MS - 1).toISOString();
    expect(
      syncProblemsFrom({
        health: running,
        tapd: { lastApplyError: { reason: 'boom', at } },
        offlineSince: null,
        now: NOW,
      })
    ).toEqual([]);
  });

  it('conflicts, and offline only once it has lasted 30 minutes', () => {
    const tapd = { offline: true, conflicts: [{ path: 'a', sidecarPath: 'b' }] };
    expect(
      syncProblemsFrom({ health: running, tapd, offlineSince: NOW - 60_000, now: NOW })
    ).toEqual([{ reason: 'conflicts' }]);
    expect(
      syncProblemsFrom({ health: running, tapd, offlineSince: NOW - OFFLINE_LONG_MS, now: NOW })
    ).toEqual([{ reason: 'conflicts' }, { reason: 'offline_long' }]);
  });

  it('a stopped daemon with work queued is daemon_stalled, counted once', () => {
    expect(
      syncProblemsFrom({
        health: { state: 'stopped' },
        tapd: { daemon: { running: false }, pendingUploads: 3 },
        offlineSince: null,
        now: NOW,
      })
    ).toEqual([{ reason: 'daemon_stalled' }]);
  });

  it('a healthy space has no problems', () => {
    expect(
      syncProblemsFrom({
        health: running,
        tapd: {
          daemon: { running: true },
          pendingApplies: 0,
          pendingUploads: 0,
          conflicts: [],
          lastApplyError: null,
          offline: false,
        },
        offlineSince: null,
        now: NOW,
      })
    ).toEqual([]);
  });
});

describe('applyErrorKind', () => {
  it('is a short code, never the words of the error', () => {
    expect(applyErrorKind('ENOSPC: no space left on device')).toBe('enospc');
    expect(applyErrorKind('blob fetch failed: 404 for secret-plans.md')).toBe('http_404');
    expect(applyErrorKind('sha256 mismatch for notes.md')).toBe('hash_mismatch');
    expect(applyErrorKind('something about my-file.md')).toBe('other');
    expect(applyErrorKind(undefined)).toBe('other');
  });
});
