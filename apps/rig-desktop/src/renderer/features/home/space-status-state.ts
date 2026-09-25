/**
 * Polish round, lane C — Home restructure ("spaces first"): the pure
 * state→rendering decisions for a space row's live status, given
 * `rpc.rig.spaceStatus.get()`'s own `RigSpaceStatus[]` (see
 * `shared/rig/space-status.ts`). Kept side-effect free and separate from
 * the components that read it, same reasoning as `home-sections.ts`'s own
 * header comment — testable with plain object literals.
 */

import { relativeTime } from '@renderer/features/chat/session-history';
import type { DotMatrixActivity, DotMatrixEnd } from '@renderer/lib/ui/dot-matrix';
import type { RigSpaceAgent, RigSpaceStatus } from '@shared/rig/space-status';

export function indexSpaceStatuses(statuses: readonly RigSpaceStatus[]): Map<string, RigSpaceStatus> {
  return new Map(statuses.map((s) => [s.bindingId, s]));
}

export function agentLabel(agent: RigSpaceAgent): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}

/**
 * How long a just-ended run still gets its own end glyph (done ✓ / failed /
 * stopped) and "{Agent} finished · Xm" subtext, before the row settles back
 * to the plain "Quiet · Xh" a genuinely idle space shows — the 1b grammar's
 * own distinction (design doc: "pricing" at 3m shows the done glyph;
 * "research"/"ops" at 2d show the dim quiet tile instead). No spec gave an
 * exact cutoff; 15 minutes is a deliberate, generous-but-not-permanent
 * window for "this just happened."
 */
export const RECENT_ENDED_MS = 15 * 60 * 1000;

export type SpaceTileState =
  | { kind: 'live'; state: DotMatrixActivity }
  | { kind: 'end'; state: DotMatrixEnd }
  /** No live run and nothing recently ended — a still, dim tile (1b: "quiet spaces = a still, dim tile"). */
  | { kind: 'quiet' };

/**
 * The row's own status tile (`SpaceStatusTile`): a running space always
 * wins (an unrecognized/absent `activity` on an otherwise-live run still
 * gets a live tile — `'thinking'`, the same honest fallback
 * `session-card.tsx`'s `OTHER_STEP` uses, rather than a falsely-calm quiet
 * one); otherwise a recently-ended run's own outcome glyph; otherwise
 * quiet.
 */
export function deriveSpaceTileState(status: RigSpaceStatus | undefined, now: number): SpaceTileState {
  const running = status?.running ?? [];
  if (running.length > 0) {
    return { kind: 'live', state: running[0]!.activity ?? 'thinking' };
  }
  const last = status?.lastRun;
  if (last && isRecentlyEnded(last.endedAt, now)) {
    const state: DotMatrixEnd = last.status === 'done' ? 'done' : last.status === 'failed' ? 'failed' : 'stopped';
    return { kind: 'end', state };
  }
  return { kind: 'quiet' };
}

function isRecentlyEnded(endedAt: string | null, now: number): boolean {
  if (!endedAt) return false;
  const at = Date.parse(endedAt);
  return !Number.isNaN(at) && now - at <= RECENT_ENDED_MS;
}

/**
 * The row's muted subtext, in words — "Claude editing metrics.md",
 * "Claude is waiting on you", "Codex finished · 3m", "Quiet · 2d". A
 * present-running item always leads (our activity vocabulary is already
 * gerund-shaped — "editing", "reading" — except `waiting`, which reads as
 * a full sentence instead, per the approved mock, since "Claude waiting" on
 * its own reads as a fragment). Falls back to `lastRun`, then plain "Quiet".
 */
export function deriveSpaceStatusLine(status: RigSpaceStatus | undefined, now: number): string {
  const running = status?.running ?? [];
  if (running.length > 0) {
    const item = running[0]!;
    const agent = agentLabel(item.agent);
    if (item.activity === 'waiting') return `${agent} is waiting on you`;
    const verb = item.activity ?? 'working';
    return item.title ? `${agent} ${verb} ${item.title}` : `${agent} ${verb}`;
  }
  const last = status?.lastRun;
  if (last?.endedAt) {
    const endedAt = Date.parse(last.endedAt);
    if (!Number.isNaN(endedAt)) {
      if (now - endedAt <= RECENT_ENDED_MS) {
        const verb = last.status === 'done' ? 'finished' : last.status === 'failed' ? 'failed' : 'stopped';
        return `${agentLabel(last.agent)} ${verb} · ${relativeTime(endedAt, now)}`;
      }
      return `Quiet · ${relativeTime(endedAt, now)}`;
    }
  }
  return 'Quiet';
}

/** True when a run this device's owner started is sitting on a pending approval — the space belongs in "Needs you." */
export function spaceNeedsApproval(status: RigSpaceStatus | undefined, selfUserId: string | null): boolean {
  if (!selfUserId) return false;
  return (status?.running ?? []).some((r) => r.activity === 'waiting' && r.ownerUserId === selfUserId);
}

export function spaceIsActive(status: RigSpaceStatus | undefined): boolean {
  return (status?.running.length ?? 0) > 0;
}

export type SpaceRowFilter = 'all' | 'needsYou' | 'active' | 'pinned';

export const SPACE_FILTER_LABELS: Record<SpaceRowFilter, string> = {
  all: 'All',
  needsYou: 'Needs you',
  active: 'Active',
  pinned: '★ Pinned',
};

export type SpaceFilterContext = {
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  pinnedIds: ReadonlySet<string>;
  selfUserId: string | null;
};

export function filterSpaceRows<T extends { bindingId: string }>(
  rows: readonly T[],
  filter: SpaceRowFilter,
  ctx: SpaceFilterContext
): T[] {
  switch (filter) {
    case 'all':
      return [...rows];
    case 'pinned':
      return rows.filter((r) => ctx.pinnedIds.has(r.bindingId));
    case 'active':
      return rows.filter((r) => spaceIsActive(ctx.statusByBinding.get(r.bindingId)));
    case 'needsYou':
      return rows.filter((r) => spaceNeedsApproval(ctx.statusByBinding.get(r.bindingId), ctx.selfUserId));
  }
}

/** How many spaces the "Needs you" pill's own count badge should show. */
export function countNeedsApproval<T extends { bindingId: string }>(
  rows: readonly T[],
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>,
  selfUserId: string | null
): number {
  return rows.filter((r) => spaceNeedsApproval(statusByBinding.get(r.bindingId), selfUserId)).length;
}

/** 0 (loudest) → 3 (quietest): waiting on you, then live, then recently ended, then quiet. */
function spaceActivityRank(status: RigSpaceStatus | undefined, selfUserId: string | null, now: number): number {
  if (spaceNeedsApproval(status, selfUserId)) return 0;
  if (spaceIsActive(status)) return 1;
  return deriveSpaceTileState(status, now).kind === 'end' ? 2 : 3;
}

/** The one timestamp that makes two same-rank rows orderable — a running item's own start, or the last run's end. */
function spaceRecencyKey(status: RigSpaceStatus | undefined, now: number): number {
  const running = status?.running ?? [];
  if (running.length > 0) {
    const at = Date.parse(running[0]!.startedAt);
    return Number.isNaN(at) ? now : at;
  }
  const endedAt = status?.lastRun?.endedAt;
  const at = endedAt ? Date.parse(endedAt) : NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** "Sorted by activity" (design doc): needs-you first, then live, then recently-ended, then quiet — most-recent-first within each tier, name as the final tiebreak. */
export function sortSpaceRowsByActivity<T extends { bindingId: string; name: string }>(
  rows: readonly T[],
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>,
  selfUserId: string | null,
  now: number
): T[] {
  return [...rows].sort((a, b) => {
    const sa = statusByBinding.get(a.bindingId);
    const sb = statusByBinding.get(b.bindingId);
    const rankDiff = spaceActivityRank(sa, selfUserId, now) - spaceActivityRank(sb, selfUserId, now);
    if (rankDiff !== 0) return rankDiff;
    const recencyDiff = spaceRecencyKey(sb, now) - spaceRecencyKey(sa, now);
    if (recencyDiff !== 0) return recencyDiff;
    return a.name.localeCompare(b.name);
  });
}

// ── Pinned spaces — purely local display state, same persistence pattern as `pinned-card.tsx`'s `readCollapsed`. ──

const PINNED_SPACES_KEY = 'rig-home-pinned-spaces';

export function readPinnedSpaceIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_SPACES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function writePinnedSpaceIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(PINNED_SPACES_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — just won't persist.
  }
}
