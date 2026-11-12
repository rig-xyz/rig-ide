import { describe, expect, it } from 'vitest';
import { APPROVAL_STALE_MS, cardLiveness, quietFor, RUN_QUIET_MS, RUN_UNHEARD_MS, runLiveness } from './run-liveness';
import { newSessionCard } from './projection';

const NOW = Date.parse('2026-11-11T20:00:00Z');
const H = 3_600_000;
const run = (over: Partial<Parameters<typeof runLiveness>[0]> = {}) => ({ status: 'running' as const, startedAt: new Date(NOW - 2 * H).toISOString(), lastEventAt: null, pendingSince: null, ...over });

describe('whether a run still going is really going', () => {
  it('says nothing about a run that ended', () => {
    expect(runLiveness(run({ status: 'done' }), NOW)).toBeNull();
    expect(runLiveness(run({ status: 'stopped' }), NOW)).toBeNull();
  });

  it('is live while its events keep coming, and stalled once quieter than any working run', () => {
    expect(runLiveness(run({ lastEventAt: NOW - 5 * 60_000 }), NOW)).toEqual({ kind: 'live' });
    expect(runLiveness(run({ lastEventAt: NOW - RUN_QUIET_MS }), NOW)).toEqual({ kind: 'stalled', since: NOW - RUN_QUIET_MS });
  });

  it("goes by when it started only when there's nothing else, and only after hours", () => {
    expect(runLiveness(run({ startedAt: new Date(NOW - 2 * H).toISOString() }), NOW)).toEqual({ kind: 'live' });
    expect(runLiveness(run({ startedAt: new Date(NOW - RUN_UNHEARD_MS).toISOString() }), NOW)).toMatchObject({ kind: 'stalled' });
  });

  it('waits on an approval however quiet, and says so once it is a day old', () => {
    // The #enes-onboarding run: asked 154h ago, nothing since.
    const asked = NOW - 154 * H;
    expect(runLiveness(run({ pendingSince: asked, lastEventAt: asked }), NOW)).toEqual({ kind: 'waiting', since: asked, stale: true });
    expect(runLiveness(run({ pendingSince: NOW - H }), NOW)).toEqual({ kind: 'waiting', since: NOW - H, stale: false });
    expect(APPROVAL_STALE_MS).toBe(24 * H);
  });

  it("reads a Room card's oldest pending approval and its last event", () => {
    const card = { ...newSessionCard(), lastEventAt: NOW - 3 * H };
    expect(cardLiveness({ startedAt: new Date(NOW - 4 * H).toISOString() }, card, 'running', NOW)).toEqual({ kind: 'stalled', since: NOW - 3 * H });
    card.permissions.pending.push({ requestId: 'r', toolCallId: 't', title: 'Run a command', options: [], requestedAt: NOW - 30 * H });
    expect(cardLiveness({ startedAt: new Date(NOW - 31 * H).toISOString() }, card, 'running', NOW)).toEqual({ kind: 'waiting', since: NOW - 30 * H, stale: true });
  });

  it('says how long in a word', () => {
    expect(quietFor(NOW - 45 * 60_000, NOW)).toBe('45m');
    expect(quietFor(NOW - 7 * H, NOW)).toBe('7h');
    expect(quietFor(NOW - 154 * H, NOW)).toBe('6d');
  });
});
