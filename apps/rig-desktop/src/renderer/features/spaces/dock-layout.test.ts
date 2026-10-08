import { describe, expect, it } from 'vitest';
import {
  BEAD,
  BEAD_INSET,
  COLUMN_MIN_WIDTH,
  columnWidth,
  computeLayout,
  floatLayout,
  GAP,
  type ColumnItem,
  type Phase,
} from './dock-layout';

const RAIL = { w: 240, h: 40 };

const pill = (id: string, w: number, extra: Partial<ColumnItem> = {}): ColumnItem => ({
  id,
  size: { w, h: 30 },
  card: false,
  phase: 'placed',
  ...extra,
});

describe('computeLayout: strictly left, ragged right', () => {
  it("gives every pill the rail's left edge, whatever its width", () => {
    const layout = computeLayout(RAIL, [
      pill('a', 60),
      pill('b', 140),
      pill('c', 100),
      pill('d', 200),
    ]);
    // A box's left edge from the dock's right edge: the same number is the same x on screen.
    const edge = (id: string) => layout.items[id]!.right + layout.items[id]!.w;
    for (const id of ['a', 'b', 'c', 'd']) expect(edge(id)).toBe(RAIL.w);
    // Ragged on the right: each pill keeps its own width.
    expect(['a', 'b', 'c', 'd'].map((id) => layout.items[id]!.w)).toEqual([60, 140, 100, 200]);
    expect(layout.width).toBe(RAIL.w);
  });

  it('sits an indented entry in from the column edge, a task row under its topic', () => {
    const layout = computeLayout(RAIL, [pill('topic', 120), pill('task', 90, { indent: 14 })]);
    const edge = (id: string) => layout.items[id]!.right + layout.items[id]!.w;
    expect(edge('topic')).toBe(RAIL.w);
    expect(edge('task')).toBe(RAIL.w - 14);
    expect(layout.items.task!.top).toBe(layout.items.topic!.top + 30 + GAP);
  });

  it('shifts only the one box that would overflow the right edge, and the others stay put', () => {
    const narrow = computeLayout(RAIL, [pill('a', 80), pill('b', 120)]);
    const wide = computeLayout(RAIL, [
      pill('a', 80),
      pill('card', 272, { card: true }),
      pill('b', 120),
    ]);
    const edge = (l: typeof wide, id: string) => l.items[id]!.right + l.items[id]!.w;
    // The card reaches left of the rail, from the right edge, and nothing else moves.
    expect(edge(wide, 'card')).toBe(272);
    expect(wide.items.card!.right).toBe(0);
    expect(edge(wide, 'a')).toBe(edge(narrow, 'a'));
    expect(edge(wide, 'b')).toBe(edge(narrow, 'b'));
    expect(edge(wide, 'a')).toBe(RAIL.w);
    // The dock is as wide as its widest box, so the transcript clears it.
    expect(wide.width).toBe(272);
    // Seen from the dock's left edge, a card wider than the rail starts at 0.
    expect(wide.width - wide.items.card!.right - wide.items.card!.w).toBe(0);
  });

  it('stacks the column under the rail with the gap that lets the goo join it', () => {
    const layout = computeLayout(RAIL, [pill('a', 60), pill('b', 60)]);
    expect(layout.items.a!.top).toBe(RAIL.h + GAP);
    expect(layout.items.b!.top).toBe(RAIL.h + GAP + 30 + GAP);
    expect(layout.height).toBe(RAIL.h + GAP + 30 + GAP + 30);
    expect(layout.rail).toMatchObject({ right: 0, top: 0, w: 240, h: 40, r: 20 });
  });

  it("pushes the column down by a card's height, not sideways", () => {
    const closed = computeLayout(RAIL, [pill('a', 60), pill('b', 60)]);
    const open = computeLayout(RAIL, [
      pill('a', 60, { card: true, size: { w: 272, h: 100 } }),
      pill('b', 60),
    ]);
    expect(open.items.a!.r).toBe(16);
    expect(open.items.b!.top).toBe(closed.items.b!.top + 70);
    expect(open.items.b!.right).toBe(closed.items.b!.right);
  });

  it('draws a pill that is a capsule, and the rail too', () => {
    const layout = computeLayout(RAIL, [pill('a', 60)]);
    expect(layout.items.a!.r).toBe(15);
  });
});

describe('computeLayout: the column is at least 208 wide', () => {
  const NARROW = { w: 120, h: 40 };

  it('puts every pill on the column left edge when the rail is narrower, the rail keeping its natural width', () => {
    const layout = computeLayout(NARROW, [pill('a', 80), pill('b', 190), pill('c', 140)]);
    const edge = (id: string) => layout.items[id]!.right + layout.items[id]!.w;
    for (const id of ['a', 'b', 'c']) expect(edge(id)).toBe(COLUMN_MIN_WIDTH);
    // Ragged right, and the rail is a cap on the right: it is not stretched.
    expect(['a', 'b', 'c'].map((id) => layout.items[id]!.w)).toEqual([80, 190, 140]);
    expect(layout.rail).toMatchObject({ right: 0, w: 120 });
    expect(layout.width).toBe(COLUMN_MIN_WIDTH);
    // From the dock's left edge every pill starts at the same x.
    const left = (id: string) => layout.width - layout.items[id]!.right - layout.items[id]!.w;
    expect(new Set(['a', 'b', 'c'].map(left))).toEqual(new Set([0]));
  });

  it('keeps the rail edge when the rail is wider, and hugs the rail when no pills hang from it', () => {
    expect(columnWidth(300)).toBe(300);
    expect(columnWidth(120)).toBe(208);
    const wide = computeLayout({ w: 300, h: 40 }, [pill('a', 100)]);
    expect(wide.items.a!.right + wide.items.a!.w).toBe(300);
    const bare = computeLayout(NARROW, []);
    expect(bare.width).toBe(120);
  });

  it('lets a pill be as wide as the column, and one wider reaches left', () => {
    const layout = computeLayout(NARROW, [pill('a', 208), pill('b', 260)]);
    expect(layout.items.a!.right).toBe(0);
    expect(layout.items.b!.right).toBe(0);
    expect(layout.width).toBe(260);
  });
});

describe('computeLayout: births come out of the listener', () => {
  const phases = (phase: Phase) =>
    computeLayout(RAIL, [pill('a', 60), pill('fresh', 90, { phase })]);

  it('starts a birth as a small shape behind the listener, and keeps its slot in the column', () => {
    const layout = phases('bead');
    const box = layout.items.fresh!;
    expect([box.w, box.h]).toEqual([BEAD, BEAD]);
    // Its centre is the listener's: BEAD_INSET from the rail's left edge, mid-height.
    expect(RAIL.w - (box.right + box.w / 2)).toBe(BEAD_INSET);
    expect(box.top + box.h / 2).toBe(RAIL.h / 2);
    // The column already made room: the slot is where the pill will be.
    expect(box.slot.top).toBe(layout.items.a!.top + 30 + GAP);
    expect(box.slot.right).toBe(RAIL.w - 90);
  });

  it('makes a drop under the rail, half tucked into it, then the pill in its slot', () => {
    const drop = phases('drop').items.fresh!;
    expect(drop.top).toBe(RAIL.h - GAP);
    expect([drop.w, drop.h]).toEqual([90, 30]);
    const placed = phases('placed').items.fresh!;
    expect(placed.top).toBe(drop.slot.top);
    expect(placed.right + placed.w).toBe(RAIL.w);
  });
});

describe('floatLayout', () => {
  it('hangs a float to the left of a pill, centred on it, with a neck bridging the gap', () => {
    const pillBox = { right: 0, w: 120, top: 100, h: 30 };
    const { box, neck } = floatLayout(pillBox, { w: 250, h: 80 }, false);
    expect(box.right).toBe(120 + 12);
    expect(box.top).toBe(100 + 15 - 40);
    // The neck sits in the gap, on the pill's middle.
    expect(neck.right).toBe(120);
    expect(neck.top + neck.h / 2).toBe(115);
  });

  it("hangs the approvals panel from the rail's top", () => {
    const { box } = floatLayout({ right: 0, w: 200, top: 0, h: 40 }, { w: 340, h: 120 }, true);
    expect(box.top).toBe(0);
    expect(box.right).toBe(212);
  });
});
