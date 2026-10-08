import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/features/notifications/space-read-sync', () => ({ reportSpaceRead: () => {}, windowIsLooking: () => false }));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const { finishedRunSeen, isRunSeen, markRunSeen, resetRunSeenForTests, seenBeforeLaunch } = await import('./run-seen');

const run = { runId: 'r1', seq: 10, endedAt: 1_000 };

beforeEach(() => {
  store.clear();
  resetRunSeenForTests();
});

describe('seenBeforeLaunch', () => {
  it('needs both: the space open after the run ended, and read past its card', () => {
    expect(seenBeforeLaunch({ lastSeenSeq: 10, openedAt: 1_000 }, run)).toBe(true);
    expect(seenBeforeLaunch({ lastSeenSeq: 9, openedAt: 5_000 }, run)).toBe(false);
    expect(seenBeforeLaunch({ lastSeenSeq: 20, openedAt: 999 }, run)).toBe(false);
    expect(seenBeforeLaunch({ lastSeenSeq: null, openedAt: 5_000 }, run)).toBe(false);
    expect(seenBeforeLaunch(undefined, run)).toBe(false);
  });
});

describe('finishedRunSeen', () => {
  it('is seen once marked this session', () => {
    expect(finishedRunSeen('b1', run)).toBe(false);
    markRunSeen('r1');
    expect(isRunSeen('r1')).toBe(true);
    expect(finishedRunSeen('b1', run)).toBe(true);
  });

  it("reads the space's markers as they were at launch, not as this session moves them", () => {
    store.set('rig-room-last-seen:b1', '12');
    store.set('rig-room-opened-at:b1', '2000');
    resetRunSeenForTests();
    expect(finishedRunSeen('b1', run)).toBe(true);
    expect(finishedRunSeen(undefined, run)).toBe(false);
    // Opening the space now does not count for a run that ended after launch's markers.
    store.set('rig-room-opened-at:b1', '9000');
    expect(finishedRunSeen('b1', { runId: 'r2', seq: 11, endedAt: 3_000 })).toBe(false);
  });
});
