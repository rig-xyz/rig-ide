import { relativeTime } from '@renderer/features/chat/session-history';
import type { Card } from '@shared/rig/card-rail';

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.2): the Suggested row's
 * REASON text — Drive's "Reason suggested" column, the design doc's own
 * north star ("intelligence appears as REASONS inside a familiar chassis").
 * Pure and tested on its own: no React, no clock of its own (`now` is
 * passed in), so `suggested-files.tsx` can call it straight from a render.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type SuggestedReason = { text: string; pulsing: boolean };

export function reasonForCard(card: Card, now: number): SuggestedReason {
  if (card.type === 'in-progress') return { text: 'Agent editing now', pulsing: true };
  // Only a pinned card can have no recency at all (never written recently,
  // never flagged unseen) — see `Card`'s own `at` comment in `card-rail.ts`.
  if (card.at === undefined) return { text: 'Pinned', pulsing: false };
  const ageMs = now - card.at;
  if (ageMs < DAY_MS) return { text: 'New today', pulsing: false };
  return { text: `Updated ${relativeTime(card.at, now)}`, pulsing: false };
}
