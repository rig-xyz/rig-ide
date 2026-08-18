import { describe, expect, it } from 'vitest';
import { minimalScrollDelta, nextPendingReveal, shouldClearReveal } from './pending-reveal';

/**
 * The pure rules the command-based scroll refactor depends on (see
 * `comments-store.ts`'s `DocCommentsStore.pendingReveal`, its round-4
 * scroll-bug history, and the round-8 simplification to a single
 * anchor-visibility reveal semantic). Tested directly rather than through
 * the mobx/IPC-entangled store.
 */

describe('nextPendingReveal', () => {
  it('sets a command for a thread with a live anchor', () => {
    expect(nextPendingReveal('t1', true, 1)).toEqual({ threadId: 't1', token: 1 });
    expect(nextPendingReveal('t2', true, 7)).toEqual({ threadId: 't2', token: 7 });
  });

  it('refuses a thread with no live anchor — the round-5 rule', () => {
    expect(nextPendingReveal('t1', false, 1)).toBeNull();
  });
});

describe('shouldClearReveal', () => {
  it('clears when the token matches the current command', () => {
    const current = { threadId: 't1', token: 3 };
    expect(shouldClearReveal(current, 3)).toBe(true);
  });

  it('does not clear when there is nothing pending', () => {
    expect(shouldClearReveal(null, 3)).toBe(false);
  });

  it('does not clear a newer command that replaced the one being consumed', () => {
    // A consumer that was slow to act on token 1 must not clobber token 2,
    // even if both target the same thread.
    const newer = { threadId: 't1', token: 2 };
    expect(shouldClearReveal(newer, 1)).toBe(false);
  });
});

describe('minimalScrollDelta — the one reveal rule', () => {
  const PADDING = 10;

  it('is 0 when the anchor is fully visible — no scroll at all', () => {
    const viewport = { top: 0, bottom: 500 };
    const anchor = { top: 100, bottom: 130 };
    expect(minimalScrollDelta(anchor, viewport, PADDING)).toBe(0);
  });

  it('is 0 when the anchor exactly touches the padded edges', () => {
    const viewport = { top: 0, bottom: 500 };
    const anchor = { top: 10, bottom: 490 }; // exactly at top+padding / bottom-padding
    expect(minimalScrollDelta(anchor, viewport, PADDING)).toBe(0);
  });

  it('scrolls up the minimal amount when the anchor is above the viewport', () => {
    const viewport = { top: 200, bottom: 700 };
    const anchor = { top: 150, bottom: 180 };
    // Bring anchor.top to viewport.top + padding: 150 - 210 = -60.
    expect(minimalScrollDelta(anchor, viewport, PADDING)).toBe(-60);
  });

  it('scrolls down the minimal amount when the anchor is below the viewport', () => {
    const viewport = { top: 0, bottom: 500 };
    const anchor = { top: 520, bottom: 550 };
    // Bring anchor.bottom to viewport.bottom - padding: 550 - 490 = 60.
    expect(minimalScrollDelta(anchor, viewport, PADDING)).toBe(60);
  });

  it('prioritizes the top edge when the anchor is taller than the viewport', () => {
    const viewport = { top: 0, bottom: 100 };
    const anchor = { top: -50, bottom: 300 }; // spans well past both edges
    // Top-edge branch wins: bring anchor.top to viewport.top + padding.
    expect(minimalScrollDelta(anchor, viewport, PADDING)).toBe(-50 - PADDING);
  });

  it('never centers — the delta is exactly the nearest-edge distance, nothing more', () => {
    const viewport = { top: 0, bottom: 500 };
    const anchor = { top: 495, bottom: 505 };
    const delta = minimalScrollDelta(anchor, viewport, PADDING);
    // If this centered, the anchor's midpoint (500) would land at the
    // viewport's midpoint (250) — a much larger delta than nearest-edge.
    expect(delta).toBe(505 - 490);
    expect(Math.abs(delta)).toBeLessThan(250);
  });
});
