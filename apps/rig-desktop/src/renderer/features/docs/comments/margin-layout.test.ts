import { describe, expect, it } from 'vitest';
import { layoutMarginCards } from './margin-layout';

describe('layoutMarginCards', () => {
  it('places well-separated cards exactly at their anchor Y', () => {
    const tops = layoutMarginCards([
      { key: 'a', anchorTop: 100, height: 40 },
      { key: 'b', anchorTop: 400, height: 40 },
    ]);
    expect(tops.get('a')).toBe(100);
    expect(tops.get('b')).toBe(400);
  });

  it('pushes a later card down when it would overlap the one above', () => {
    const tops = layoutMarginCards([
      { key: 'a', anchorTop: 100, height: 200 }, // bottom at 300
      { key: 'b', anchorTop: 120, height: 40 }, // anchor inside a's span
    ]);
    expect(tops.get('a')).toBe(100);
    expect(tops.get('b')).toBe(308); // 300 + gap(8)
  });

  it('cascades the push through three overlapping cards', () => {
    const tops = layoutMarginCards([
      { key: 'a', anchorTop: 0, height: 100 },
      { key: 'b', anchorTop: 10, height: 100 },
      { key: 'c', anchorTop: 20, height: 50 },
    ]);
    expect(tops.get('a')).toBe(0);
    expect(tops.get('b')).toBe(108);
    expect(tops.get('c')).toBe(216);
  });

  it('reflows back up when an earlier card shrinks — the whole point of recomputing fresh every time', () => {
    const tall = layoutMarginCards([
      { key: 'a', anchorTop: 0, height: 300 },
      { key: 'b', anchorTop: 50, height: 40 },
    ]);
    expect(tall.get('b')).toBe(308);

    // Same items, 'a' now collapsed to a much shorter card (e.g. folded).
    const shrunk = layoutMarginCards([
      { key: 'a', anchorTop: 0, height: 24 },
      { key: 'b', anchorTop: 50, height: 40 },
    ]);
    expect(shrunk.get('a')).toBe(0);
    expect(shrunk.get('b')).toBe(50); // back to its own anchor Y, no longer pushed
  });

  it('stacks an unanchored item (the new-comment composer) right after the previous card', () => {
    const tops = layoutMarginCards([
      { key: 'thread-1', anchorTop: 100, height: 60 },
      { key: 'composer', anchorTop: null, height: 90 },
    ]);
    expect(tops.get('thread-1')).toBe(100);
    expect(tops.get('composer')).toBe(168); // 100 + 60 + gap(8)
  });

  it('places a lone unanchored item at the very top', () => {
    const tops = layoutMarginCards([{ key: 'composer', anchorTop: null, height: 90 }]);
    expect(tops.get('composer')).toBe(0);
  });

  it('never places a card above its own anchor, even out of reading order', () => {
    // Anchors given out of order on purpose: the function trusts its input
    // order (callers sort), so an out-of-order anchor after a tall card still
    // only ever gets pushed down, never up past its own anchor.
    const tops = layoutMarginCards([
      { key: 'a', anchorTop: 500, height: 20 },
      { key: 'b', anchorTop: 10, height: 20 },
    ]);
    expect(tops.get('a')).toBe(500);
    expect(tops.get('b')).toBe(528); // pushed down from its own anchor(10) to a's bottom + gap
  });

  it('is a pure function of its inputs: same items in, same tops out, regardless of call history', () => {
    const items = [
      { key: 'a', anchorTop: 40, height: 60 },
      { key: 'b', anchorTop: 90, height: 30 },
    ];
    const first = layoutMarginCards(items);
    const second = layoutMarginCards(items);
    expect([...second]).toEqual([...first]);
  });
});

describe('layoutMarginCards with an active card (priority layout)', () => {
  it('pins the active card to exactly its own anchor Y, even behind a long earlier card', () => {
    const items = [
      { key: 'a', anchorTop: 0, height: 300 }, // bottom at 300, would push a plain top-down layout's next card to 308
      { key: 'active', anchorTop: 50, height: 40 }, // its own anchor sits well inside 'a's span
    ];

    const tops = layoutMarginCards(items, 8, 1);

    // The whole point: not pushed down to 308 the way the plain algorithm would.
    expect(tops.get('active')).toBe(50);
  });

  it('yields the card above upward when it would otherwise overlap the active card', () => {
    const items = [
      { key: 'a', anchorTop: 0, height: 300 },
      { key: 'active', anchorTop: 50, height: 40 },
    ];

    const tops = layoutMarginCards(items, 8, 1);

    // 'a' must end with its bottom at least `gap` above the active card's
    // top(50) — i.e. top + height <= 50 - 8 = 42, so top <= -258.
    expect(tops.get('a')).toBe(-258);
    expect((tops.get('a') ?? 0) + 300).toBeLessThanOrEqual(50 - 8);
  });

  it('cascades the upward yield through multiple cards above the active one', () => {
    const items = [
      { key: 'a', anchorTop: 0, height: 100 },
      { key: 'b', anchorTop: 10, height: 100 },
      { key: 'active', anchorTop: 20, height: 40 },
    ];

    const tops = layoutMarginCards(items, 8, 2);

    expect(tops.get('active')).toBe(20);
    expect(tops.get('b')).toBe(-88); // 20 - 8 - 100
    expect(tops.get('a')).toBe(-196); // -88 - 8 - 100
  });

  it('an above-active card keeps its own anchor Y when there is no overlap to yield to', () => {
    const items = [
      { key: 'a', anchorTop: 0, height: 20 }, // bottom at 20, nowhere near active's top
      { key: 'active', anchorTop: 500, height: 40 },
    ];

    const tops = layoutMarginCards(items, 8, 1);

    expect(tops.get('a')).toBe(0);
    expect(tops.get('active')).toBe(500);
  });

  it('yields the card below downward when it would otherwise overlap the active card', () => {
    const items = [
      { key: 'active', anchorTop: 50, height: 200 }, // bottom at 250
      { key: 'b', anchorTop: 100, height: 40 }, // anchor inside active's span
    ];

    const tops = layoutMarginCards(items, 8, 0);

    expect(tops.get('active')).toBe(50);
    expect(tops.get('b')).toBe(258); // 250 + gap(8), same rule the plain algorithm uses
  });

  it('below-active cards still cascade top-down exactly like the plain algorithm', () => {
    const items = [
      { key: 'active', anchorTop: 0, height: 100 },
      { key: 'b', anchorTop: 10, height: 100 },
      { key: 'c', anchorTop: 20, height: 50 },
    ];

    const tops = layoutMarginCards(items, 8, 0);

    expect(tops.get('active')).toBe(0);
    expect(tops.get('b')).toBe(108);
    expect(tops.get('c')).toBe(216);
  });

  it('is unchanged from the plain top-down layout when there is no active card', () => {
    const items = [
      { key: 'a', anchorTop: 0, height: 100 },
      { key: 'b', anchorTop: 10, height: 100 },
      { key: 'c', anchorTop: 20, height: 50 },
    ];

    const plain = layoutMarginCards(items);
    expect([...layoutMarginCards(items, 8, undefined)]).toEqual([...plain]);
    expect([...layoutMarginCards(items, 8, null)]).toEqual([...plain]);
    // Out-of-range indices fall back the same way.
    expect([...layoutMarginCards(items, 8, -1)]).toEqual([...plain]);
    expect([...layoutMarginCards(items, 8, items.length)]).toEqual([...plain]);
  });

  it('handles a lone active card with nothing above or below it', () => {
    const tops = layoutMarginCards([{ key: 'active', anchorTop: 42, height: 30 }], 8, 0);
    expect(tops.get('active')).toBe(42);
  });

  it('never pins a null-anchor active card to a false top(0) — the resolved-thread click trap', () => {
    // A resolved/orphaned thread's anchor no longer resolves in the document
    // — `anchorTop: null` — but it can still become "active" (clicked in the
    // rail). Pinning it to `0` regardless (the bug) drags the whole layout,
    // and via the card's own scroll-into-view, the shared scroll container,
    // up to a position with nothing to do with this thread.
    const items = [
      { key: 'a', anchorTop: 500, height: 40 },
      { key: 'active', anchorTop: null, height: 60 },
      { key: 'b', anchorTop: 700, height: 40 },
    ];

    const tops = layoutMarginCards(items, 8, 1);

    // Falls back to the plain top-down layout entirely for this call — the
    // anchorless active card takes its ordinary stacked-after-previous spot,
    // not a pinned `0`.
    expect(tops.get('active')).not.toBe(0);
    expect(tops.get('a')).toBe(500);
    expect(tops.get('active')).toBe(548); // 500 + 40 + gap(8)
    expect(tops.get('b')).toBe(700);
  });

  it('a null-anchor active card as the very first item still only lands at 0 via the ordinary top-down rule, not a special pin', () => {
    const items = [
      { key: 'active', anchorTop: null, height: 30 },
      { key: 'b', anchorTop: 10, height: 40 },
    ];

    const withActive = layoutMarginCards(items, 8, 0);
    const withoutActive = layoutMarginCards(items, 8, null);

    // Identical to the plain algorithm's own answer — proof this is the
    // ordinary "first unanchored item starts at 0" rule, not the
    // active-priority pin reappearing under a different name.
    expect([...withActive]).toEqual([...withoutActive]);
  });
});
