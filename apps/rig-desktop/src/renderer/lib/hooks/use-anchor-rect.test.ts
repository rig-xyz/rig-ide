import { describe, expect, it } from 'vitest';
import { computeAnchorRect } from './use-anchor-rect';

const VIEWPORT = { width: 1000, height: 800 };
const GAP = 4;

function box(partial: Partial<{ top: number; bottom: number; left: number; right: number; width: number }>) {
  return { top: 0, bottom: 0, left: 0, right: 0, width: 0, ...partial };
}

describe('computeAnchorRect — vertical placement', () => {
  it('picks "below" when there is plainly enough room below the trigger', () => {
    const rect = computeAnchorRect(
      box({ top: 100, bottom: 120, left: 10, right: 60, width: 50 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 200, estimatedWidth: 100, align: 'left' }
    );
    expect(rect.placement).toBe('below');
  });

  it('flips to "above" when the trigger sits near the bottom of the window', () => {
    const rect = computeAnchorRect(
      box({ top: 750, bottom: 780, left: 10, right: 60, width: 50 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 200, estimatedWidth: 100, align: 'left' }
    );
    expect(rect.placement).toBe('above');
  });
});

describe('computeAnchorRect — horizontal align', () => {
  it('keeps a left-aligned trigger left-aligned when there is room to its right', () => {
    const rect = computeAnchorRect(
      box({ top: 100, bottom: 120, left: 20, right: 80, width: 60 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 100, estimatedWidth: 200, align: 'left' }
    );
    expect(rect.align).toBe('left');
  });

  it('the "Add" menu bug: a left-preferring trigger near the RIGHT edge flips to right-aligned', () => {
    // Trigger sits at x=950..980 in a 1000px-wide window; a 200px-wide
    // left-aligned popup would run to x=1180 — well past the edge.
    const rect = computeAnchorRect(
      box({ top: 100, bottom: 120, left: 950, right: 980, width: 30 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 100, estimatedWidth: 200, align: 'left' }
    );
    expect(rect.align).toBe('right');
  });

  it('a right-preferring trigger (Share, invites bell, user pill) stays right-aligned near the right edge', () => {
    const rect = computeAnchorRect(
      box({ top: 100, bottom: 120, left: 950, right: 980, width: 30 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 100, estimatedWidth: 320, align: 'right' }
    );
    expect(rect.align).toBe('right');
  });

  it('a right-preferring trigger flips to left-aligned when it sits near the LEFT edge instead', () => {
    // Trigger at x=10..40; a 320px-wide right-aligned popup would run to
    // x=-280 — off the left edge.
    const rect = computeAnchorRect(
      box({ top: 100, bottom: 120, left: 10, right: 40, width: 30 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 100, estimatedWidth: 320, align: 'right' }
    );
    expect(rect.align).toBe('left');
  });

  it('when NEITHER side fully fits, picks whichever side has more room (mirrors the vertical "better of two bad options" rule)', () => {
    // Trigger near dead center of a narrow-ish window; estimatedWidth (600)
    // can't fit on either side, so the wider of the two wins.
    const rect = computeAnchorRect(
      box({ top: 100, bottom: 120, left: 400, right: 430, width: 30 }),
      VIEWPORT,
      { gap: GAP, estimatedHeight: 100, estimatedWidth: 600, align: 'left' }
    );
    // spaceLeftAlign = 1000 - 400 - 4 = 596; spaceRightAlign = 430 - 4 = 426
    expect(rect.align).toBe('left');
  });
});
