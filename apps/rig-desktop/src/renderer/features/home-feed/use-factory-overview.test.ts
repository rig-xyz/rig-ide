import { describe, expect, it, vi } from 'vitest';
import type { SpaceRun, SpaceState, ViewWork } from '@shared/rig/space-state';
import { factoryOf } from './use-factory-overview';

// The hook's module talks to the app; `factoryOf` does not, and there is no window here.
vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, events: {} }));

const view = (over: Partial<ViewWork>): ViewWork => ({
  view: 'v',
  everyMs: 3_600_000,
  runsAs: 'me',
  runsHere: true,
  needsAccept: false,
  dataModifiedMs: null,
  refreshingRunId: null,
  lastRefresh: null,
  nextDueAt: 5_000,
  skipped: null,
  ...over,
});
const run = (over: Partial<SpaceRun>): SpaceRun => ({
  runId: 'r',
  startedBy: 'clock',
  view: 'v',
  ownerUserId: 'me',
  agent: 'claude',
  startedAt: 1,
  state: 'working',
  step: 'Reading',
  stepKind: 'reading',
  lastEventAt: 1,
  endedAt: null,
  ...over,
});
const state = (views: ViewWork[], runs: SpaceRun[] = []): SpaceState => ({ bindingId: 'b', at: 0, views, runs });

describe('factoryOf', () => {
  it('counts the views that run here on a schedule, and finds the soonest', () => {
    const f = factoryOf(
      state([
        view({ view: 'a', nextDueAt: 9_000 }),
        view({ view: 'b', nextDueAt: 4_000 }),
        view({ view: 'c', everyMs: null, nextDueAt: null }),
        view({ view: 'd', runsHere: false, nextDueAt: 1_000 }),
      ])
    );
    expect(f).toEqual({ run: null, scheduled: 2, nextDueAt: 4_000 });
  });
  it('shows the pass going now, one that waits on the person first, and ignores ended ones', () => {
    const f = factoryOf(
      state([], [
        run({ runId: 'done', state: 'done' }),
        run({ runId: 'working', startedAt: 5 }),
        run({ runId: 'waiting', state: 'waiting', startedAt: 2 }),
      ])
    );
    expect(f.run?.runId).toBe('waiting');
    expect(factoryOf(state([])).run).toBeNull();
  });
});
