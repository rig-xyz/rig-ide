import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { OrchAgentState } from '../feed/relay';
import { CATCH_UP_AFTER_MS, createCatchUp, readWindow } from './catch-up';

const NOW = Date.parse('2026-10-27T09:00:00Z');
const HOUR = 3_600_000;

function state(over: Partial<OrchAgentState> = {}): OrchAgentState {
  return {
    me: 'Dylan',
    profile: '',
    rules: [],
    lastRun: null,
    cursors: {},
    due: [],
    events: [],
    counts: { open: 0, visible: 0, queued: 0, following: 0, untopiced: 0 },
    bare: [],
    ...over,
  };
}

describe('readWindow', () => {
  it('reads from the oldest cursor, and last read at the newest', () => {
    const w = readWindow(
      state({ lastRun: { id: 'r', at: '2026-10-26T18:00:00Z' }, cursors: { slack: '2026-10-26T18:00:00Z', linear: '2026-10-26T12:00:00Z' } }),
      NOW
    );
    expect(w.since).toBe('2026-10-26T12:00:00.000Z');
    expect(w.lastRead).toBe(Date.parse('2026-10-26T18:00:00Z'));
  });

  it('falls back to the last run when its note named no cursors', () => {
    expect(readWindow(state({ lastRun: { id: 'r', at: '2026-10-26T18:00:00Z' } }), NOW).since).toBe('2026-10-26T18:00:00.000Z');
  });

  it('has no window for someone Rig never read for', () => {
    expect(readWindow(state(), NOW)).toEqual({ lastRead: null, since: null });
  });

  it('never reaches back more than two weeks', () => {
    const w = readWindow(state({ cursors: { slack: '2026-08-01T00:00:00Z' } }), NOW);
    expect(Date.parse(w.since!)).toBe(NOW - 14 * 24 * HOUR);
  });
});

function setUp(over: { lastRead?: string | null; firstRunDone?: boolean; running?: boolean } = {}) {
  let now = NOW;
  const lastRead = over.lastRead === undefined ? new Date(NOW - 10 * HOUR).toISOString() : over.lastRead;
  const run = vi.fn(async () => ok(null));
  const catchUp = createCatchUp({
    state: async () => ok(state(lastRead ? { lastRun: { id: 'r', at: lastRead }, cursors: { slack: lastRead } } : {})),
    firstRunDone: () => over.firstRunDone ?? true,
    running: () => over.running ?? false,
    run,
    now: () => now,
  });
  return { catchUp, run, advance: (ms: number) => (now += ms) };
}

describe('createCatchUp', () => {
  it('runs a catch-up from the last read when Rig last read hours ago', async () => {
    const { catchUp, run } = setUp();
    expect(await catchUp.maybe('app start')).toBe('started');
    expect(run).toHaveBeenCalledWith('catch-up', { since: new Date(NOW - 10 * HOUR).toISOString() });
  });

  it('not when Rig read a little while ago', async () => {
    const { catchUp, run } = setUp({ lastRead: new Date(NOW - CATCH_UP_AFTER_MS + 60_000).toISOString() });
    expect(await catchUp.maybe('wake')).toBe('not_due');
    expect(run).not.toHaveBeenCalled();
  });

  it('never before onboarding is done, for someone never read for, or on top of a run going', async () => {
    expect(await setUp({ firstRunDone: false }).catchUp.maybe('app start')).toBe('skipped');
    expect(await setUp({ lastRead: null }).catchUp.maybe('app start')).toBe('skipped');
    expect(await setUp({ running: true }).catchUp.maybe('app start')).toBe('skipped');
  });

  it('skips when Rig can’t be asked', async () => {
    const catchUp = createCatchUp({
      state: async () => err({ message: 'no relay' }),
      firstRunDone: () => true,
      running: () => false,
      run: vi.fn(),
      now: () => NOW,
    });
    expect(await catchUp.maybe('wake')).toBe('skipped');
  });

  it('keeps its own run’s events for a Home that mounts late, and lets them go a while after it ends', async () => {
    const { catchUp, advance } = setUp();
    await catchUp.maybe('app start');
    expect(catchUp.status()).toBeNull();
    catchUp.record({ run: 'other', kind: 'start', trigger: 'schedule', passes: 1, lookups: 20, lookbackDays: 3, t: 0 });
    catchUp.record({ run: 'c1', kind: 'start', trigger: 'catch-up', passes: 1, lookups: 20, lookbackDays: 3, t: 0 });
    catchUp.record({ run: 'other', kind: 'card', ref: 'sit_x', t: 5 });
    catchUp.record({ run: 'c1', kind: 'card', ref: 'sit_a', fresh: true, t: 9 });
    expect(catchUp.status()).toEqual({ events: [expect.objectContaining({ kind: 'start' }), expect.objectContaining({ ref: 'sit_a' })], ended: false });
    catchUp.record({ run: 'c1', kind: 'end', ok: true, t: 20 });
    expect(catchUp.status()?.ended).toBe(true);
    advance(3 * 60_000);
    expect(catchUp.status()).toBeNull();
  });

  it('keeps the first run too, which First win leaves reading, long enough for Home to show its All caught up', () => {
    const { catchUp, advance } = setUp();
    catchUp.record({ run: 'f1', kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 });
    catchUp.record({ run: 'f1', kind: 'card', ref: 'sit_a', fresh: true, t: 9 });
    catchUp.record({ run: 'f1', kind: 'end', ok: true, t: 90 });
    advance(10 * 60_000);
    expect(catchUp.status()).toEqual({ events: [expect.objectContaining({ trigger: 'first' }), expect.objectContaining({ ref: 'sit_a' }), expect.objectContaining({ kind: 'end' })], ended: true });
    advance(30 * 60_000);
    expect(catchUp.status()).toBeNull();
  });
});
