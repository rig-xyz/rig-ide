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
  | { kind: 'forYou'; count: number; line: string; messages: number; exact?: boolean }
  /**
   * 1–9 from this computer's own marker, where 9 means "9+" (it only sees
   * the newest 9). `exact` when the count is the relay's (up to 99).
   */
  | { kind: 'messages'; count: number; exact?: boolean }
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

/** A live run waiting on you: your own, sitting on an approval. Someone else's waits on them. */
export function isWaitingOnYou(attention: SpaceAttention): boolean {
  return attention.kind === 'live' && attention.state === 'waiting' && !attention.owner;
}

/**
 * The row's tile and line, in the order of `deriveSpaceRowLine`'s ladder: a
 * run of yours waiting on you; then the last run failing after you last
 * opened the space; then any other running item (an absent `activity` still
 * gets a live tile — `'thinking'`, the same honest fallback
 * `session-card.tsx`'s `OTHER_STEP` uses); then the last run finishing
 * after you last opened it (a stopped run was someone's own choice, nothing
 * to flag); then new messages; else idle. With no "opened" marker nothing
 * reads as unseen — `baselineMarker` sets one the first time Home sees a
 * space. Mentions and other notifications fold in after (`withNotifications`).
 */
export function deriveSpaceAttention(
  status: RigSpaceStatus | undefined,
  marker: SpaceSeenMarker | null,
  selfUserId: string | null
): SpaceAttention {
  const running = status?.running ?? [];
  const withOwner = (owner: string | undefined) => (owner ? { owner } : {});
  const live: SpaceAttention | null =
    running.length > 0
      ? { kind: 'live', state: running[0]!.activity ?? 'thinking', ...withOwner(ownerOf(running[0], selfUserId)) }
      : null;
  if (live && isWaitingOnYou(live)) return live;
  const last = status?.lastRun;
  const endedAt = parseTime(last?.endedAt);
  const openedAt = marker?.openedAt ?? null;
  const unseen = last && endedAt !== null && openedAt !== null && endedAt > openedAt ? last : null;
  if (unseen?.status === 'failed') {
    return { kind: 'failed', agent: unseen.agent, endedAt: endedAt!, ...withOwner(ownerOf(unseen, selfUserId)) };
  }
  if (live) return live;
  if (unseen?.status === 'done') {
    return { kind: 'finished', agent: unseen.agent, endedAt: endedAt!, ...withOwner(ownerOf(unseen, selfUserId)) };
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
      const others = attention.count - 1;
      const more = others > 0 ? ` · ${others >= MAX_EXACT_MESSAGES ? `${MAX_EXACT_MESSAGES}+` : others} more for you` : '';
      const news =
        attention.count === 1 && attention.messages > 1 ? ` · ${newMessages(attention.messages, attention.exact)}` : '';
      return `${attention.line}${more}${news}`;
    }
    case 'messages':
      return newMessages(attention.count, attention.exact);
    case 'idle':
      return attention.lastActivityAt === null ? 'No activity yet' : relativeTime(attention.lastActivityAt, now);
  }
}

/** The rungs of `deriveSpaceRowLine`'s ladder this module decides; rung 1 is the row's sync notice. */
export type SpaceLineRung = 2 | 3 | 4 | 5 | 6 | 7;

export type SpaceLineTone = 'danger' | 'secondary' | 'muted';

const RUNG_TONE: Record<SpaceLineRung, SpaceLineTone> = {
  2: 'secondary',
  3: 'danger',
  4: 'muted',
  5: 'secondary',
  6: 'muted',
  7: 'muted',
};

/**
 * A Spaces row's one line. The highest rung that applies owns it:
 *
 * | # | Rung                 | Attention                    | Line                                  | Tone      |
 * |---|----------------------|------------------------------|---------------------------------------|-----------|
 * | 1 | Sync broken          | the row's sync notice        | "Sync paused · Resume"                | its own   |
 * | 2 | Needs you            | forYou, live waiting on you  | "Hugo mentioned you · 2 more for you" | secondary |
 * | 3 | Failed               | failed                       | "Hugo's Claude failed · 20m ago"      | danger    |
 * | 4 | Live                 | live                         | "Hugo's Claude editing Pricing.md"    | muted     |
 * | 5 | New since you looked | finished, messages           | "Topic · 3 new messages"              | secondary |
 * | 6 | Seen, active today   | idle, with a topic today     | "Topic · 3h ago"                      | muted     |
 * | 7 | Nothing new          | idle                         | "4d ago", "No activity yet"           | muted     |
 *
 * Rung 1 is rendered by the row itself (its notice carries an action) and
 * takes the line whenever sync is broken; this decides rungs 2–7, whose
 * order `deriveSpaceAttention` and `withNotifications` already keep. The
 * topic, the space's busiest Room theme today, leads only rungs 5 and 6:
 * above them, who or what needs you owns the line.
 */
export function deriveSpaceRowLine(input: {
  status: RigSpaceStatus | undefined;
  attention: SpaceAttention;
  topic: string | null | undefined;
  now: number;
}): { text: string; tone: SpaceLineTone; rung: SpaceLineRung } {
  const { status, attention, topic, now } = input;
  const rung: SpaceLineRung =
    attention.kind === 'forYou' || isWaitingOnYou(attention)
      ? 2
      : attention.kind === 'failed'
        ? 3
        : attention.kind === 'live'
          ? 4
          : attention.kind !== 'idle'
            ? 5
            : topic
              ? 6
              : 7;
  const line = deriveSpaceStatusLine(status, attention, now);
  let text = line;
  if (topic && (rung === 5 || rung === 6)) {
    text = attention.kind === 'idle' && attention.lastActivityAt === null ? topic : `${topic} · ${line}`;
  }
  return { text, tone: RUNG_TONE[rung], rung };
}

/** How much a Spaces row stands out, loudest first. */
export type SpaceRowWeight = 'needs' | 'live' | 'unread' | 'quiet';

/**
 * A row's weight and the count on its right, from the same ladder as its
 * line (`deriveSpaceRowLine`): rung 2 needs you (an accent bar, a bold name,
 * the reason as its line); a live run shows its motion; something new since
 * you looked (rungs 3 and 5) is bold with its count; the rest is quiet and
 * steps back. The count is the unread messages, else the rows about you,
 * capped like the line ("9+" from this computer's marker, "99+" from the
 * relay's count). Null when there's nothing to count.
 */
export function deriveSpaceRowWeight(
  attention: SpaceAttention,
  rung: SpaceLineRung
): { weight: SpaceRowWeight; count: string | null } {
  const count =
    attention.kind === 'messages'
      ? countLabel(attention.count, attention.exact)
      : attention.kind === 'forYou'
        ? countLabel(attention.messages > 0 ? attention.messages : attention.count, attention.messages > 0 ? attention.exact : true)
        : null;
  if (rung === 2) return { weight: 'needs', count };
  if (attention.kind === 'live') return { weight: 'live', count: null };
  if (rung === 3 || rung === 5) return { weight: 'unread', count };
  return { weight: 'quiet', count: null };
}

function countLabel(count: number, exact = false): string {
  const cap = exact ? MAX_EXACT_MESSAGES : MAX_NEW_MESSAGES;
  return count > cap || (!exact && count >= cap) ? `${cap}+` : String(count);
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

export type SpaceRowFilter = 'all' | 'needsYou' | 'unread';

export const SPACE_FILTER_LABELS: Record<SpaceRowFilter, string> = {
  all: 'All',
  needsYou: 'Needs you',
  unread: 'Unread',
};

/** Something new in the space for you to read: messages past your read position, or rows about you. */
export function hasUnread(attention: SpaceAttention): boolean {
  return attention.kind === 'messages' || attention.kind === 'forYou';
}

export type SpaceFilterContext = {
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
  /**
   * Spaces that need you, mentions and requests included (the Spaces card's
   * own signals, `space-sections.ts`). Without it, "Needs you" is only a
   * run of yours waiting on approval.
   */
  needsYouIds?: ReadonlySet<string>;
  /** Spaces with something unread (`hasUnread` on each row's attention). Without it, "Unread" is empty. */
  unreadIds?: ReadonlySet<string>;
};

export function filterSpaceRows<T extends { bindingId: string }>(
  rows: readonly T[],
  filter: SpaceRowFilter,
  ctx: SpaceFilterContext
): T[] {
  switch (filter) {
    case 'all':
      return [...rows];
    case 'unread':
      return rows.filter((r) => ctx.unreadIds?.has(r.bindingId) ?? false);
    case 'needsYou':
      return rows.filter((r) =>
        ctx.needsYouIds
          ? ctx.needsYouIds.has(r.bindingId)
          : spaceNeedsApproval(ctx.statusByBinding.get(r.bindingId), ctx.selfUserId)
      );
  }
}

/** 0 (loudest) → 3 (quietest): waiting on you, then live, then something you missed, then idle. */
function spaceActivityRank(
  status: RigSpaceStatus | undefined,
  attention: SpaceAttention,
  selfUserId: string | null
): number {
  if (spaceNeedsApproval(status, selfUserId)) return 0;
  // Running, even when the row leads with an unseen failure instead.
  if (attention.kind === 'live' || spaceIsActive(status)) return 1;
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

/** The relay counts up to 100 unread; this computer's own marker sees only the newest 9. */
const MAX_EXACT_MESSAGES = 99;

function newMessages(count: number, exact = false): string {
  if (count === 1) return '1 new message';
  const cap = exact ? MAX_EXACT_MESSAGES : MAX_NEW_MESSAGES;
  return count >= cap && !(exact && count === cap) ? `${cap}+ new messages` : `${count} new messages`;
}

/**
 * Folds notifications into a row's attention (rig docs/notifications-spec.md
 * §5). Once the relay's summary is in (`known`), its count of unread
 * messages replaces this computer's own marker diff, so the row, the
 * Activity bell and the Dock all read one read position that every device
 * shares. Unread rows about you sit on the ladder's "Needs you" rung
 * (`deriveSpaceRowLine`): they outrank a failed or live run, a finished one
 * and new messages; only a run of yours waiting on you stays. A muted space
 * ('nothing') stays quiet: no "for you", no "new messages", just when
 * something last happened; its mentions wait in Activity.
 */
export function withNotifications(
  attention: SpaceAttention,
  status: RigSpaceStatus | undefined,
  notifications: {
    level: 'all' | 'mentions' | 'nothing';
    directUnread: number;
    spaceUnread?: number;
    known?: boolean;
  },
  latestDirect: { phrase: string } | null
): SpaceAttention {
  if (isWaitingOnYou(attention)) return attention;
  const idle: SpaceAttention = { kind: 'idle', lastActivityAt: lastActivityAt(status) };
  let base = attention;
  if (notifications.known && (attention.kind === 'messages' || attention.kind === 'idle')) {
    const unread = notifications.spaceUnread ?? 0;
    base = unread > 0 ? { kind: 'messages', count: Math.min(unread, MAX_EXACT_MESSAGES + 1), exact: true } : idle;
  }
  if (notifications.level === 'nothing') return base.kind === 'messages' ? idle : base;
  if (notifications.directUnread > 0 && latestDirect) {
    return {
      kind: 'forYou',
      // Exact up to 100 for the line; the dice caps itself at nine.
      count: Math.min(notifications.directUnread, MAX_EXACT_MESSAGES + 1),
      line: latestDirect.phrase,
      messages: base.kind === 'messages' ? base.count : 0,
      exact: base.kind === 'messages' && base.exact === true,
    };
  }
  return base;
}
