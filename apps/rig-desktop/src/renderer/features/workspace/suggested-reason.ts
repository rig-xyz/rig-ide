import { relativeTime } from '@renderer/features/chat/session-history';
import type { Card } from '@shared/rig/card-rail';

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.2): the Suggested row's
 * REASON text — Drive's "Reason suggested" column, the design doc's own
 * north star ("intelligence appears as REASONS inside a familiar chassis").
 * Pure and tested on its own: no React, no clock of its own (`now` is
 * passed in), so `suggested-files.tsx` can call it straight from a render.
 */

export type SuggestedReason = { text: string; pulsing: boolean };

export function reasonForCard(card: Card, now: number): SuggestedReason {
  if (card.type === 'in-progress') return { text: 'Agent editing now', pulsing: true };
  // Only a pinned card can have no recency at all (never written recently,
  // never flagged unseen) — see `Card`'s own `at` comment in `card-rail.ts`.
  if (card.at === undefined) return { text: 'Pinned', pulsing: false };
  // Always the actual recency. No "New today": the card data can't
  // distinguish created from modified, so "new" would be a guess, and a
  // rolling-24h window isn't "today" anyway — a real time is strictly
  // more informative than either.
  return { text: `Updated ${relativeTime(card.at, now)}`, pulsing: false };
}
