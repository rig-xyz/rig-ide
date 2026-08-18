/**
 * Pure decision rules behind `DocCommentsStore.pendingReveal` — the store's
 * one-shot "scroll this into view" command, and the single owner of every
 * scroll in the docs feature (see the store's own doc comment for the full
 * design). Split out into a standalone module, the same way `margin-layout.ts`
 * and `anchors.ts` already are, so what matters is unit-testable without the
 * store's mobx/IPC machinery.
 *
 * ROUND-8 SIMPLIFICATION (was: two reveal targets, 'card' and 'anchor'):
 * a two-comments-on-one-line repro showed the 'card' target scrolling to the
 * card element's pre-layout position — active-priority layout (in
 * `margin-layout.ts`) then relocates the newly-active card to sit at its own
 * anchor Y, so a scroll aimed at the card's *current* rendered position was
 * racing that relocation and landing stale. Two scroll semantics can race
 * each other; one can't. So there is now exactly one: "ensure the thread's
 * anchor is minimally visible" — never the card (Docs' actual model: the
 * card comes to the text via layout, the viewport never chases the card).
 *
 * The store has no view/DOM access, so it cannot itself know whether an
 * anchor is already visible — `_requestReveal` always sets the command
 * (subject only to the round-5 "has a live anchor at all" rule below); the
 * consuming effect is what measures visibility and decides whether any
 * scroll is actually needed. Simpler invariant than trying to have the store
 * pre-empt a no-op: one rule ("has an anchor") stays where the anchor data
 * lives, one rule ("is it visible") stays where the viewport data lives.
 */

export type PendingReveal = { threadId: string; token: number };

/**
 * What `DocCommentsStore._requestReveal` should set, or `null` to refuse the
 * request outright — the round-5 rule. There is nothing worth revealing for a
 * thread the document can't currently point to (unpositioned or orphaned).
 */
export function nextPendingReveal(
  threadId: string,
  hasLiveAnchor: boolean,
  token: number
): PendingReveal | null {
  return hasLiveAnchor ? { threadId, token } : null;
}

/**
 * Whether consuming `token` should clear `current`.
 *
 * True only when `current` is still the exact command `token` was issued
 * for — never when it's already null, and never when a newer command (a
 * different token, even for the same thread) has since replaced it.
 */
export function shouldClearReveal(current: PendingReveal | null, token: number): boolean {
  return current !== null && current.token === token;
}

// ── minimal-scroll rect math ─────────────────────────────────────────────
//
// The one reveal rule, made concrete: bring `anchor` minimally into view
// within `viewport`, or do nothing at all when it's already there. Both are
// vertical spans in the *scroll container's own content coordinate space*
// (i.e. `viewport = [scrollTop, scrollTop + clientHeight]`) — the same space
// `useMarginLayout`'s own anchor-Y math already works in, so the consumer
// can feed this straight off `coordsAtPos` + `getBoundingClientRect` without
// a separate conversion.

export type VerticalSpan = { top: number; bottom: number };

/**
 * The scrollTop delta that makes `anchor` minimally visible inside
 * `viewport`, or `0` when it already is — never centers, never moves the
 * viewport further than the anchor requires.
 *
 * `padding` keeps the anchor from sitting flush against the viewport edge.
 * When `anchor` is taller than `viewport`, showing its top edge takes
 * priority over its bottom — satisfying both is impossible, and top-first
 * matches where reading starts (checked first, below, for exactly that
 * case).
 */
export function minimalScrollDelta(
  anchor: VerticalSpan,
  viewport: VerticalSpan,
  padding: number
): number {
  const top = viewport.top + padding;
  const bottom = viewport.bottom - padding;
  if (anchor.top < top) return anchor.top - top;
  if (anchor.bottom > bottom) return anchor.bottom - bottom;
  return 0;
}
