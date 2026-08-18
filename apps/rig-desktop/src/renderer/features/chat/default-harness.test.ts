import { describe, expect, it } from 'vitest';
import { deriveDefaultHarness } from './default-harness';

const base = {
  runnable: ['codex', 'claude'] as const,
  lastKnownRunnable: [] as const,
  lastForRig: null,
  lastGlobal: null,
};

describe('deriveDefaultHarness', () => {
  it('prefers the rig’s own last harness over everything', () => {
    expect(
      deriveDefaultHarness({ ...base, lastForRig: 'claude', lastGlobal: 'codex' })
    ).toBe('claude');
  });

  it('falls back to the global most-recently-used harness for a brand-new rig', () => {
    expect(deriveDefaultHarness({ ...base, lastGlobal: 'claude' })).toBe('claude');
  });

  it('only falls back to probe order when no history exists', () => {
    expect(deriveDefaultHarness({ ...base })).toBe('codex');
  });

  it('honors a remembered preference the LIVE probe has not confirmed yet, when last-known vouches — the boot race', () => {
    // Boot: codex's 40ms probe landed, claude's ~1s one hasn't — but claude
    // was runnable last run and is the user's actual preference.
    expect(
      deriveDefaultHarness({
        runnable: ['codex'],
        lastKnownRunnable: ['claude', 'codex'],
        lastForRig: null,
        lastGlobal: 'claude',
      })
    ).toBe('claude');
  });

  it('drops a remembered preference nothing vouches for (uninstalled since)', () => {
    expect(
      deriveDefaultHarness({
        runnable: ['codex'],
        lastKnownRunnable: ['codex'],
        lastForRig: 'claude',
        lastGlobal: 'claude',
      })
    ).toBe('codex');
  });

  it('uses last-known runnability alone before any live probe lands', () => {
    expect(
      deriveDefaultHarness({
        runnable: [],
        lastKnownRunnable: ['claude'],
        lastForRig: null,
        lastGlobal: null,
      })
    ).toBe('claude');
  });

  it('returns null when nothing is or was runnable', () => {
    expect(
      deriveDefaultHarness({ runnable: [], lastKnownRunnable: [], lastForRig: null, lastGlobal: null })
    ).toBeNull();
  });

  /**
   * A6 (first-time-rig probe-arrival flip): with no rig/global preference
   * to anchor on, this function falls all the way through to
   * `runnable[0]` — a plain array-index pick with NO memory of what it
   * returned last call. Two calls with a different probe snapshot (a
   * slower agent's probe landing after a faster one already did) are free
   * to disagree, on purpose — `deriveDefaultHarness` itself is stateless
   * by design and re-derives fresh every time it's called (see the file's
   * own header comment: "callers re-derive on every input change"). This
   * documents exactly why `chat-panel.tsx`'s eager-session effect can't
   * lean on this function ALONE for stability once a real session exists:
   * it has to pin the choice itself (`manualPickRef.current = true` the
   * instant an eager store is created) rather than assume re-deriving is
   * ever idempotent across probe arrivals.
   */
  it('probe order alone is NOT stable across calls — a later-arriving slower probe can flip runnable[0] (why callers must pin their own choice once acted on)', () => {
    const firstProbeSnapshot = deriveDefaultHarness({
      runnable: ['codex'], // codex's ~40ms probe landed first
      lastKnownRunnable: [],
      lastForRig: null,
      lastGlobal: null,
    });
    expect(firstProbeSnapshot).toBe('codex');

    const secondProbeSnapshot = deriveDefaultHarness({
      runnable: ['claude', 'codex'], // claude's slower probe has now also landed, reordering the array
      lastKnownRunnable: [],
      lastForRig: null,
      lastGlobal: null,
    });
    expect(secondProbeSnapshot).toBe('claude');
    expect(secondProbeSnapshot).not.toBe(firstProbeSnapshot);
  });
});
