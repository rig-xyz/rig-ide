/**
 * Pure margin-card positioning: Google Docs' model, precisely.
 *
 * Cards sit in a right gutter aligned to their anchor's Y. Given in reading
 * order (callers pass items already sorted by anchor position — the store's
 * `visibleThreads` already is), each card's top is its own anchor Y, unless
 * that would overlap the card above it, in which case it is pushed down to
 * sit `gap` below that card's bottom. When an earlier card shrinks (collapses,
 * a "Show more" closes, a reply is removed), calling this again with the new
 * heights naturally pulls everything below it back up — there is no separate
 * "reflow" step to remember to run, because this never has state of its own:
 * every call is a fresh layout from the same three inputs (anchor Y, height,
 * order), never a diff against the previous one.
 *
 * With `activeIndex` set, Docs' *priority* layout applies instead: the active
 * card is pinned to exactly its own anchor Y — never pushed down by whatever
 * sits above it — and every other card yields to make room, outward from
 * there: cards above lay out bottom-up off the active card's top edge (their
 * own anchor Y when there's room, pushed *up* past it when there isn't), cards
 * below lay out top-down off its bottom edge exactly as the plain algorithm
 * always has. This is what keeps the active card from ending up half a screen
 * from its highlighted text just because an earlier long card pushed it down.
 */

export type MarginLayoutItem = {
  key: string;
  /** Document-relative Y of the card's anchor, or null when it has none (stacks right after the previous card). */
  anchorTop: number | null;
  /** The card's current rendered height. */
  height: number;
};

export const MARGIN_CARD_GAP = 8;

/**
 * Card key → its computed `top`, in the same coordinate space as `anchorTop`.
 *
 * @param activeIndex Index into `items` of the active card, when there is
 *   one. Out-of-range values (including omitted/null) fall back to the plain
 *   top-down layout — the behavior with no active card at all.
 */
export function layoutMarginCards(
  items: readonly MarginLayoutItem[],
  gap: number = MARGIN_CARD_GAP,
  activeIndex?: number | null
): Map<string, number> {
  if (activeIndex == null || activeIndex < 0 || activeIndex >= items.length) {
    return layoutTopDown(items, gap);
  }
  // An "active" card with no anchor (its quoted passage no longer resolves in
  // the document — a resolved or orphaned thread) has no Y worth prioritizing
  // around. Pinning it to `0` anyway is exactly the bug this guards against:
  // the whole rail — and, via the card's own scroll-into-view, the shared
  // scroll container it lives in — would snap to a fake "top of the document"
  // position that has nothing to do with this thread. Falling back to the
  // plain layout instead means an anchorless active card just takes its
  // ordinary stacked-after-the-previous-card spot, same as any other
  // unanchored item — never a false floor.
  if (items[activeIndex]!.anchorTop === null) {
    return layoutTopDown(items, gap);
  }
  return layoutActivePriority(items, gap, activeIndex);
}

function layoutTopDown(items: readonly MarginLayoutItem[], gap: number): Map<string, number> {
  const tops = new Map<string, number>();
  let prevBottom: number | null = null;

  for (const item of items) {
    const desired: number = item.anchorTop ?? (prevBottom === null ? 0 : prevBottom + gap);
    const top: number = prevBottom === null ? desired : Math.max(desired, prevBottom + gap);
    tops.set(item.key, top);
    prevBottom = top + item.height;
  }

  return tops;
}

/** Only ever called with an active item that has a real anchor — see the `null` guard in `layoutMarginCards`. */
function layoutActivePriority(
  items: readonly MarginLayoutItem[],
  gap: number,
  activeIndex: number
): Map<string, number> {
  const tops = new Map<string, number>();

  const active = items[activeIndex]!;
  const activeTop = active.anchorTop!;
  tops.set(active.key, activeTop);

  // Above the active card: bottom-up, closest-to-active first. Each card
  // keeps its own anchor Y unless that would overlap the card below it (the
  // active card, or the one just placed), in which case it yields *upward*.
  let ceiling = activeTop;
  for (let i = activeIndex - 1; i >= 0; i--) {
    const item = items[i]!;
    const maxTop = ceiling - gap - item.height;
    const desired: number = item.anchorTop ?? maxTop;
    const top = Math.min(desired, maxTop);
    tops.set(item.key, top);
    ceiling = top;
  }

  // Below the active card: top-down off its bottom edge — the same rule the
  // plain algorithm always applied, just starting from the active card's
  // bottom instead of from nothing.
  let floor = activeTop + active.height;
  for (let i = activeIndex + 1; i < items.length; i++) {
    const item = items[i]!;
    const minTop = floor + gap;
    const desired: number = item.anchorTop ?? minTop;
    const top = Math.max(desired, minTop);
    tops.set(item.key, top);
    floor = top + item.height;
  }

  return tops;
}
