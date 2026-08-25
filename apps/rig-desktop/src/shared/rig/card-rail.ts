/**
 * File-navigator redesign (`docs/file-navigator-design.md` §3): pure
 * card-selection math for the card rail — no IO, no React, no timestamps of
 * its own. `renderer/features/workspace/card-rail.tsx` supplies the three
 * raw signals (pins from settings, in-progress writes from
 * `write-activity.ts`, fresh/unseen files from `seen-state.ts`) and this
 * decides which files become cards, in what order, with no file ever
 * appearing twice across the three types.
 */

export type CardType = 'pinned' | 'in-progress' | 'fresh';

export type WriteSignal = { relPath: string; at: number; sessionId: string };
export type FreshSignal = { relPath: string; at: number };

export type Card = {
  type: CardType;
  relPath: string;
  /** Best-known recency for this card. Undefined only for a pinned file with no other known signal (never written recently, never flagged unseen). */
  at?: number;
  /** Set only when the card's recency comes from an agent session write — an in-progress card, or a pinned file that also happens to be one right now. */
  sessionId?: string;
};

export type SelectCardsInput = {
  /** Pin order (oldest pin first) — always shown, unbounded, always first. */
  pinnedRelPaths: readonly string[];
  inProgress: readonly WriteSignal[];
  fresh: readonly FreshSignal[];
  /** In-progress + fresh combined cap. Pinned cards are never counted against it. */
  maxNonPinned?: number;
};

const DEFAULT_MAX_NON_PINNED = 5;

/**
 * Pinned first (all of them), then in-progress (newest first), then fresh
 * (newest first) filling whatever's left of `maxNonPinned` — in-progress
 * outranks fresh by construction (it's placed first and never displaced).
 * A relPath already used by an earlier, higher-priority card is skipped
 * everywhere it appears again.
 */
export function selectCards(input: SelectCardsInput): Card[] {
  const maxNonPinned = input.maxNonPinned ?? DEFAULT_MAX_NON_PINNED;
  const inProgressByPath = new Map(input.inProgress.map((w) => [w.relPath, w] as const));
  const freshByPath = new Map(input.fresh.map((f) => [f.relPath, f] as const));
  const used = new Set<string>();

  const pinnedCards: Card[] = [];
  for (const relPath of input.pinnedRelPaths) {
    if (used.has(relPath)) continue;
    used.add(relPath);
    const write = inProgressByPath.get(relPath);
    const freshEntry = freshByPath.get(relPath);
    pinnedCards.push({
      type: 'pinned',
      relPath,
      at: write?.at ?? freshEntry?.at,
      sessionId: write?.sessionId,
    });
  }

  const nonPinnedCards: Card[] = [];
  const inProgressSorted = [...input.inProgress].sort((a, b) => b.at - a.at);
  for (const write of inProgressSorted) {
    if (nonPinnedCards.length >= maxNonPinned) break;
    if (used.has(write.relPath)) continue;
    used.add(write.relPath);
    nonPinnedCards.push({ type: 'in-progress', relPath: write.relPath, at: write.at, sessionId: write.sessionId });
  }

  if (nonPinnedCards.length < maxNonPinned) {
    const freshSorted = [...input.fresh].sort((a, b) => b.at - a.at);
    for (const freshEntry of freshSorted) {
      if (nonPinnedCards.length >= maxNonPinned) break;
      if (used.has(freshEntry.relPath)) continue;
      used.add(freshEntry.relPath);
      nonPinnedCards.push({ type: 'fresh', relPath: freshEntry.relPath, at: freshEntry.at });
    }
  }

  return [...pinnedCards, ...nonPinnedCards];
}
