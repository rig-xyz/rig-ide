/**
 * Polish round, lane C — Home restructure ("spaces first"): the pure
 * state→rendering decisions for a space row's live status, given
 * `rpc.rig.spaceStatus.get()`'s own `RigSpaceStatus[]` (see
 * `shared/rig/space-status.ts`). Kept side-effect free and separate from
 * the components that read it, same reasoning as `home-sections.ts`'s own
 * header comment — testable with plain object literals.
 */

import { relativeTime } from '@renderer/features/chat/session-history';
import type { DotMatrixActivity } from '@renderer/lib/ui/dot-matrix';
import type { RigSpaceAgent, RigSpaceStatus } from '@shared/rig/space-status';

export function indexSpaceStatuses(statuses: readonly RigSpaceStatus[]): Map<string, RigSpaceStatus> {
  return new Map(statuses.map((s) => [s.bindingId, s]));
}

export function agentLabel(agent: RigSpaceAgent): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}

/** When nobody's name is known for a teammate's run. */
export const UNKNOWN_OWNER = 'A teammate';

/**
 * Whose run it is, for the line: `undefined` for your own (or when who "you"
 * are isn't known), else the owner's first name ("Sam" for "Sam Lee"),
 * falling back to `UNKNOWN_OWNER`.
 */
export function ownerOf(
  item: { ownerUserId: string; ownerName?: string } | undefined,
  selfUserId: string | null
): string | undefined {
  if (!item || !selfUserId || item.ownerUserId === selfUserId) return undefined;
  return item.ownerName?.trim().split(/\s+/)[0] || UNKNOWN_OWNER;
}

/** "Claude" for yours, "Sam's Claude" for someone else's. */
export function agentPhrase(agent: RigSpaceAgent, owner: string | undefined): string {
  return owner ? `${owner}'s ${agentLabel(agent)}` : agentLabel(agent);
}

// ── What a space's tile says ("E · what you missed") ──
//
// The ONE thing in a space most worth your attention, in priority order:
// something live (the 1b motions) › the last run failed while you were away
// (red cross) › it finished while you were away (green check) › new
// messages since you last read the space (dice faces) › otherwise nothing
// for you: a faint pattern that belongs to the space. "While you were away"
// / "since you last read" come from the Room's own per-space read markers
// (`features/spaces/room-read-marker.ts`); opening the space clears them.

/** New-message counts as dice faces (cells row-major 0–8). 5 is a plus, so it can't read as the failed cross; 9 fills the grid and means "9+". */
export const DICE_FACES: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [1, 3, 4, 5, 7],
  6: [0, 2, 3, 5, 6, 8],
  7: [0, 2, 3, 4, 5, 6, 8],
  8: [0, 1, 2, 3, 5, 6, 7, 8],
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

export const MAX_NEW_MESSAGES = 9;

const patternKey = (cells: readonly number[]) => [...cells].sort((a, b) => a - b).join(',');

/**
 * Cell sets an idle pattern may never be: every dice face, the done (✓)
 * and failed (✕) glyphs, and any full row, column or diagonal (which covers
 * the queued bar) — so a space's own pattern never reads as a status.
 */
export const RESERVED_PATTERNS: ReadonlySet<string> = new Set(
  [
    ...Object.values(DICE_FACES),
    [1, 3, 5, 7],
    [0, 2, 4, 6, 8],
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [2, 4, 6],
  ].map(patternKey)
);

/**
 * A space's own idle pattern: 3–4 lit cells, seeded by its bindingId so it
 * never changes, and never one of `RESERVED_PATTERNS`. An FNV-1a hash seeds
 * a small xorshift-multiply generator; a draw that lands on a reserved set
 * is redrawn (the design prototype's own rule). Returns the lit cells,
 * sorted — empty only if 50 draws in a row were reserved.
 */
export function idlePattern(seed: string): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rnd = () => (h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296;
  for (let tries = 0; tries < 50; tries++) {
    const n = 3 + Math.floor(rnd() * 2);
    const on = new Set<number>();
    while (on.size < n) on.add(Math.floor(rnd() * 9));
    const cells = [...on].sort((a, b) => a - b);
    if (!RESERVED_PATTERNS.has(patternKey(cells))) return cells;
  }
  return [];
}

/** Mirrors `features/spaces/room-read-marker.ts`'s `SpaceReadMarker` (kept structural so this module stays storage-free). */
export type SpaceSeenMarker = { lastSeenSeq: number | null; openedAt: number | null };

/** `owner` is set only when the run isn't yours: who to name in the line (see `ownerOf`). */
export type SpaceAttention =
  | { kind: 'live'; state: DotMatrixActivity; owner?: string }
  | { kind: 'failed'; agent: RigSpaceAgent; endedAt: number; owner?: string }
  | { kind: 'finished'; agent: RigSpaceAgent; endedAt: number; owner?: string }
  /**
   * Notifications about you (mentions, replies, your agent, requests to it):
   * `line` names the newest ("Hugo mentioned you"), `count` is how many are
   * unread (1–9; 9 means "9+"), shown on the dice like new messages are.
   */
  | { kind: 'forYou'; count: number; line: string; messages: number }
  /** 1–9; 9 means "9+". */
  | { kind: 'messages'; count: number }
  /** Nothing for you. `lastActivityAt` is null when nothing ever happened in the space. */
  | { kind: 'idle'; lastActivityAt: number | null };

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** The newest thing that happened in a space: a run starting or ending, or a message. */
export function lastActivityAt(status: RigSpaceStatus | undefined): number | null {
  const times = [
    ...(status?.running ?? []).map((r) => parseTime(r.startedAt)),
    parseTime(status?.lastRun?.endedAt),
    ...(status?.recentMessages ?? []).map((m) => parseTime(m.createdAt)),
  ].filter((t): t is number => t !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Messages newer than your read marker that someone else wrote — a
 * teammate, their agent's turn, a share-link guest (stamped with the link
 * creator's id, so `authorKind` is what tells it apart). Your own messages
 * and your own agent's turns never count. Capped at `MAX_NEW_MESSAGES`: the
 * relay sends the newest nine, so nine of nine newer is "9+". No marker
 * (never read here) counts nothing.
 */
export function countNewMessages(
  status: RigSpaceStatus | undefined,
  lastSeenSeq: number | null,
  selfUserId: string | null
): number {
  if (lastSeenSeq === null) return 0;
  const count = (status?.recentMessages ?? []).filter(
    (m) => m.seq > lastSeenSeq && (m.authorKind === 'guest' || m.authorUserId !== selfUserId)
  ).length;
  return Math.min(count, MAX_NEW_MESSAGES);
}

/**
 * The row's tile and line, in priority order: a running item always wins
 * (an absent `activity` still gets a live tile — `'thinking'`, the same
 * honest fallback `session-card.tsx`'s `OTHER_STEP` uses); then the last
 * run's outcome if it ended after you last opened the space (only failed
 * and done — a stopped run was someone's own choice, nothing to flag);
 * then new messages; else idle. With no "opened" marker nothing reads as
 * unseen — `baselineMarker` sets one the first time Home sees a space.
 */
export function deriveSpaceAttention(
  status: RigSpaceStatus | undefined,
  marker: SpaceSeenMarker | null,
  selfUserId: string | null
): SpaceAttention {
  const running = status?.running ?? [];
  const withOwner = (owner: string | undefined) => (owner ? { owner } : {});
  if (running.length > 0) {
    return { kind: 'live', state: running[0]!.activity ?? 'thinking', ...withOwner(ownerOf(running[0], selfUserId)) };
  }
  const last = status?.lastRun;
  const endedAt = parseTime(last?.endedAt);
  const openedAt = marker?.openedAt ?? null;
  if (last && endedAt !== null && openedAt !== null && endedAt > openedAt) {
    const owner = withOwner(ownerOf(last, selfUserId));
    if (last.status === 'failed') return { kind: 'failed', agent: last.agent, endedAt, ...owner };
    if (last.status === 'done') return { kind: 'finished', agent: last.agent, endedAt, ...owner };
  }
  const count = countNewMessages(status, marker?.lastSeenSeq ?? null, selfUserId);
  if (count > 0) return { kind: 'messages', count };
  return { kind: 'idle', lastActivityAt: lastActivityAt(status) };
}

/**
 * The row's second line, in words — "Claude editing metrics.md", "Claude
 * is waiting on you", "Codex failed · 1h ago", "3 new messages", "2d ago",
 * "No activity yet". Every row has one, so rows keep one height. A live
 * item's activity is already gerund-shaped ("editing", "reading") except
 * `waiting`, which reads as a full sentence instead (per the approved mock).
 * Someone else's agent is named as theirs: "Sam's Claude finished · 5m ago",
 * "Sam's Claude is waiting on Sam".
 */
export function deriveSpaceStatusLine(
  status: RigSpaceStatus | undefined,
  attention: SpaceAttention,
  now: number
): string {
  switch (attention.kind) {
    case 'live': {
      const item = status!.running[0]!;
      const agent = agentPhrase(item.agent, attention.owner);
      if (item.activity === 'waiting') {
        return attention.owner && attention.owner !== UNKNOWN_OWNER
          ? `${agent} is waiting on ${attention.owner}`
          : attention.owner
            ? `${agent} is waiting for approval`
            : `${agent} is waiting on you`;
      }
      const verb = item.activity ?? 'working';
      return item.title ? `${agent} ${verb} ${item.title}` : `${agent} ${verb}`;
    }
    case 'failed':
      return `${agentPhrase(attention.agent, attention.owner)} failed · ${relativeTime(attention.endedAt, now)}`;
    case 'finished':
      return `${agentPhrase(attention.agent, attention.owner)} finished · ${relativeTime(attention.endedAt, now)}`;
    case 'forYou': {
      const more = attention.count > 1 ? ` · ${attention.count - 1} more for you` : '';
      const news = attention.count === 1 && attention.messages > 1 ? ` · ${newMessages(attention.messages)}` : '';
      return `${attention.line}${more}${news}`;
    }
    case 'messages':
      if (attention.count === 1) return '1 new message';
      return attention.count >= MAX_NEW_MESSAGES ? `${MAX_NEW_MESSAGES}+ new messages` : `${attention.count} new messages`;
    case 'idle':
      return attention.lastActivityAt === null ? 'No activity yet' : relativeTime(attention.lastActivityAt, now);
  }
}

/** The line's tone: a failure in the muted-error tone, anything else unseen a step brighter than the idle/live muted text. */
export function spaceStatusLineTone(attention: SpaceAttention): 'danger' | 'secondary' | 'muted' {
  if (attention.kind === 'failed') return 'danger';
  if (attention.kind === 'finished' || attention.kind === 'messages' || attention.kind === 'forYou') return 'secondary';
  return 'muted';
}

/**
 * What to remember for a space this device has no marker for yet (never
 * opened here, or opened before these markers existed): "seen up to now",
 * so the first Home after an update — or after being added to a space —
 * doesn't light every row up with its whole history; only what happens
 * from here on counts. The message baseline waits for a relay that sends
 * `recentMessages` (an older one can't say what "now" is). Returns null
 * when there's nothing to write.
 */
export function baselineMarker(
  status: RigSpaceStatus,
  marker: SpaceSeenMarker,
  now: number
): Partial<{ lastSeenSeq: number; openedAt: number }> | null {
  const out: Partial<{ lastSeenSeq: number; openedAt: number }> = {};
  if (marker.lastSeenSeq === null && status.recentMessages) {
    out.lastSeenSeq = Math.max(0, ...status.recentMessages.map((m) => m.seq));
  }
  if (marker.openedAt === null) out.openedAt = now;
  return Object.keys(out).length > 0 ? out : null;
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

/** 0 (loudest) → 3 (quietest): waiting on you, then live, then something you missed, then idle. */
function spaceActivityRank(
  status: RigSpaceStatus | undefined,
  attention: SpaceAttention,
  selfUserId: string | null
): number {
  if (spaceNeedsApproval(status, selfUserId)) return 0;
  if (attention.kind === 'live') return 1;
  return attention.kind === 'idle' ? 3 : 2;
}

/** The one timestamp that makes two same-rank rows orderable — a running item's own start, else the space's latest activity. */
function spaceRecencyKey(status: RigSpaceStatus | undefined, now: number): number {
  const running = status?.running ?? [];
  if (running.length > 0) return parseTime(running[0]!.startedAt) ?? now;
  return lastActivityAt(status) ?? 0;
}

/** "Sorted by activity" (design doc): needs-you first, then live, then what you missed, then idle — most-recent-first within each tier, name as the final tiebreak. */
export function sortSpaceRowsByActivity<T extends { bindingId: string; name: string }>(
  rows: readonly T[],
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>,
  attentionByBinding: ReadonlyMap<string, SpaceAttention>,
  selfUserId: string | null,
  now: number,
  /**
   * Each space's last activity on this computer, counted alongside the live
   * status so the order is already right before the statuses arrive (they
   * load after the list; without this the first paint sorted every space as
   * inactive, alphabetically, and reshuffled a moment later).
   */
  localActivity?: ReadonlyMap<string, number | null>
): T[] {
  const idle: SpaceAttention = { kind: 'idle', lastActivityAt: null };
  const recency = (bindingId: string, status: RigSpaceStatus | undefined) =>
    Math.max(spaceRecencyKey(status, now), localActivity?.get(bindingId) ?? 0);
  return [...rows].sort((a, b) => {
    const sa = statusByBinding.get(a.bindingId);
    const sb = statusByBinding.get(b.bindingId);
    const rankDiff =
      spaceActivityRank(sa, attentionByBinding.get(a.bindingId) ?? idle, selfUserId) -
      spaceActivityRank(sb, attentionByBinding.get(b.bindingId) ?? idle, selfUserId);
    if (rankDiff !== 0) return rankDiff;
    const recencyDiff = recency(b.bindingId, sb) - recency(a.bindingId, sa);
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

function newMessages(count: number): string {
  if (count === 1) return '1 new message';
  return count >= MAX_NEW_MESSAGES ? `${MAX_NEW_MESSAGES}+ new messages` : `${count} new messages`;
}

/**
 * Folds notifications into a row's attention (rig docs/notifications-spec.md
 * §5): unread rows about you outrank plain new messages and a finished run,
 * never a live or failed one. A muted space ('nothing') stays quiet: no
 * "for you", no "new messages", just when something last happened. Those
 * mentions wait in Activity.
 */
export function withNotifications(
  attention: SpaceAttention,
  status: RigSpaceStatus | undefined,
  notifications: { level: 'all' | 'mentions' | 'nothing'; directUnread: number },
  latestDirect: { phrase: string } | null
): SpaceAttention {
  if (attention.kind === 'live' || attention.kind === 'failed') return attention;
  if (notifications.level === 'nothing') {
    return attention.kind === 'messages' ? { kind: 'idle', lastActivityAt: lastActivityAt(status) } : attention;
  }
  if (notifications.directUnread > 0 && latestDirect) {
    return {
      kind: 'forYou',
      count: Math.min(notifications.directUnread, MAX_NEW_MESSAGES),
      line: latestDirect.phrase,
      messages: attention.kind === 'messages' ? attention.count : 0,
    };
  }
  return attention;
}
