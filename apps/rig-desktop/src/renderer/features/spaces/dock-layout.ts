/**
 * Room themes (rig/docs/room-themes-spec.md §7): where each shape of the dock
 * goes, as a pure function of what the dock measured, so the rules are
 * testable without a browser. `components/dock-stage.tsx` measures and draws.
 *
 * Every coordinate is measured from the dock's own right edge (`right`) and
 * its top (`top`): the dock hangs from the corner, so a wider pill never
 * moves another one. A box's left edge, from the dock's left, is `left`.
 *
 * The column is "Across + Left": every pill's left edge is the column's left
 * edge, `min(railLeft, rightEdge - COLUMN_MIN_WIDTH)`: the rail's own left edge
 * when the rail is wide, and further left when it is narrow, so the rail sits
 * like a cap on the right of the column and a pill's name has room. Only a pill
 * wider than the column reaches further left, from the right edge.
 */

/** The gap between the rail and the pills, and between pills: close enough for the goo to join them. */
export const GAP = 6;
/** The listener's centre, from the rail's left edge: the rail's left padding (12) and half the listener's 28px slot. */
export const BEAD_INSET = 26;
/** A tucked shape: a drop no bigger than a dot of the listener. */
export const BEAD = 12;
/** A card's corner radius; pills and the rail are capsules. */
export const CARD_RADIUS = 16;
/** A float (peek, approvals) sits this far from what it hangs from, joined by a neck. */
export const FLOAT_GAP = 12;
export const FLOAT_RADIUS = 14;
export const NECK = 12;

/** The pill column is never narrower than this, however little the rail holds. */
export const COLUMN_MIN_WIDTH = 208;
/** The column's width for a rail this wide: where every pill's left edge is, from the dock's right edge. */
export const columnWidth = (railWidth: number): number => Math.max(railWidth, COLUMN_MIN_WIDTH);
/** The dock's one toggle sits this far in from the rail's top-right corner, and is this big. */
export const CORNER_INSET = 6;
export const CORNER_SIZE = 28;

export type Size = { w: number; h: number };

/** Where a column entry is in its birth: still the bead, a drop under the rail, or in its place. */
export type Phase = 'bead' | 'drop' | 'placed';

export type ColumnItem = {
  id: string;
  /** Null until measured. */
  size: Size | undefined;
  card: boolean;
  phase: Phase;
  /** Sits this far in from the column's left edge (a task row under its topic). */
  indent?: number;
};

export type Box = { right: number; top: number; w: number; h: number; r: number };
export type PlacedBox = Box & {
  /** From the dock's left edge. */
  left: number;
  /** Where the entry is headed: its place in the column, whatever its phase. */
  slot: { right: number; top: number };
};

export type DockLayout = {
  /** The dock's width: its widest part. */
  width: number;
  height: number;
  rail: Box;
  /** A shape at rest behind the listener: where drops come from and go back to. */
  bead: Box;
  items: Record<string, PlacedBox>;
};

export function computeLayout(rail: Size, column: readonly ColumnItem[]): DockLayout {
  const beadCx = rail.w - BEAD_INSET;
  const bead: Box = {
    right: beadCx - BEAD / 2,
    top: rail.h / 2 - BEAD / 2,
    w: BEAD,
    h: BEAD,
    r: BEAD / 2,
  };
  const items: Record<string, PlacedBox> = {};
  let width = rail.w;
  const columnW = columnWidth(rail.w);
  let y = rail.h + GAP;
  const placed: Array<{ id: string; size: Size; top: number; card: boolean; indent: number }> = [];
  for (const item of column) {
    if (!item.size) {
      items[item.id] = { ...bead, left: 0, slot: { right: bead.right, top: bead.top } };
      continue;
    }
    const { w, h } = item.size;
    const indent = item.indent ?? 0;
    const right = Math.max(0, columnW - indent - w);
    placed.push({ id: item.id, size: item.size, top: y, card: item.card, indent });
    width = Math.max(width, right + w);
    y += h + GAP;
  }
  const height = placed.length > 0 ? y - GAP : rail.h;
  const phases = new Map(column.map((item) => [item.id, item.phase]));
  for (const { id, size, top, card, indent } of placed) {
    const { w, h } = size;
    const right = Math.max(0, columnW - indent - w);
    const r = card ? CARD_RADIUS : h / 2;
    const phase = phases.get(id) ?? 'placed';
    const slot = { right, top };
    let box: Box;
    if (phase === 'bead') box = bead;
    else if (phase === 'drop') {
      // A drop under the rail's start, tucked half into the rail so the goo joins them.
      box = { right: Math.max(0, rail.w - 2 - w), top: rail.h - GAP, w, h, r };
    } else box = { right, top, w, h, r };
    items[id] = { ...box, left: width - box.right - box.w, slot };
  }
  return {
    width,
    height: Math.max(height, rail.h),
    rail: { right: 0, top: 0, w: rail.w, h: rail.h, r: rail.h / 2 },
    bead,
    items,
  };
}

export type FloatLayout = { box: Box; neck: Box };

/**
 * A float to the left of `anchor`: the rail (its top is the rail's) or a
 * pill (its middle is the pill's middle). `neck` is the bead of goo bridging
 * the gap, so the float reads as hanging from what it is about.
 */
export function floatLayout(
  anchor: { right: number; w: number; top: number; h: number },
  size: Size,
  anchorsTop: boolean
): FloatLayout {
  const edge = anchor.right + anchor.w;
  const cy = anchor.top + anchor.h / 2;
  const top = anchorsTop ? anchor.top : Math.max(-8, cy - size.h / 2);
  return {
    box: { right: edge + FLOAT_GAP, top, w: size.w, h: size.h, r: FLOAT_RADIUS },
    neck: { right: edge, top: cy - NECK / 2, w: NECK, h: NECK, r: NECK / 2 },
  };
}
