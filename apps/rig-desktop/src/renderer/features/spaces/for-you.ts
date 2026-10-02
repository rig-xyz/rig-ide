/**
 * "For you" (rig/docs/room-themes-spec.md §7): what is waiting on you in one
 * Room, as a pure model. Two kinds of item:
 *
 *  - Asks of you: inbox rows for this Space of type mention, reply or comment.
 *    A request to your agent is not an ask of you. Read state can't drive this
 *    (opening the Room marks its rows read), so an ask leaves on being handled:
 *    you replied to that message, or in its thread, after it; or you dismissed it.
 *  - Approvals: your own runs here with permission requests still pending.
 *
 * Everything is derived from the snapshot and the inbox rows on every call;
 * nothing is stored here but the dismissals (`for-you-dismissed.ts`).
 */

import type { RigNotification } from '@shared/rig/notifications';
import { runCard } from './projection';
import type { AgentKind, RoomMessage, RoomSnapshot, SessionPermissionOption } from './types';

/** What `computeForYou` reads of a Room. */
export type ForYouSnapshot = Pick<
  RoomSnapshot,
  'messages' | 'members' | 'sessionMetaByRun' | 'sessionEventsByRun' | 'sessionSummaryByRun'
>;

export type Ask = {
  /** The inbox row to dismiss: the oldest of this message's rows. */
  notificationId: string;
  /** Every inbox row about this message (a mention and a reply can both exist); dismissing any of them dismisses the ask. */
  notificationIds: string[];
  type: 'mention' | 'reply' | 'comment';
  messageId: string;
  /** The message's seq: from the Room when loaded, else from the row. */
  messageSeq: number | null;
  /** Whether the message is in the loaded window, i.e. whether the transcript can jump to it. */
  loaded: boolean;
  actor: RigNotification['actor'];
  /** A word or two of the message, from the row. */
  body: string;
  createdAt: string;
};

export type ApprovalRequest = {
  requestId: string;
  title: string;
  options: SessionPermissionOption[];
};

export type Approval = {
  runId: string;
  /** The run's card in the transcript; null when its message is older than the loaded window. */
  sessionMessageId: string | null;
  agent: AgentKind;
  /** Who asked: the person a request row names for this run, else the run's owner (you; requests to your agent are always your own today). */
  askedBy: { id: string; name: string };
  pending: ApprovalRequest[];
};

export type ForYou = {
  /** Oldest first. */
  asks: Ask[];
  /** Oldest first. */
  approvals: Approval[];
  /** The asks' message ids and each approval's session message id: what the transcript keeps in focus, and what a theme's blue dot looks for. */
  messageIds: Set<string>;
};

export const EMPTY_FOR_YOU: ForYou = { asks: [], approvals: [], messageIds: new Set() };

const ASK_TYPES = new Set<string>(['mention', 'reply', 'comment']);

export type ComputeForYouInput = {
  snapshot: ForYouSnapshot;
  /** The user's id as it appears on messages (`authorId`) and runs (`owner`). */
  selfUserId: string;
  /** Inbox rows; rows of other Spaces are ignored. */
  notifications: readonly RigNotification[];
  /** This Space's id, for the rows. */
  bindingId: string;
  /** Inbox row ids the user dismissed. */
  dismissed: ReadonlySet<string>;
};

export function computeForYou({
  snapshot,
  selfUserId,
  notifications,
  bindingId,
  dismissed,
}: ComputeForYouInput): ForYou {
  const rows = notifications.filter((n) => n.bindingId === bindingId);
  const asks = computeAsks(snapshot, selfUserId, rows, dismissed);
  const approvals = computeApprovals(snapshot, selfUserId, rows);
  return { asks, approvals, messageIds: messageIdsOf(asks, approvals) };
}

function messageIdsOf(asks: readonly Ask[], approvals: readonly Approval[]): Set<string> {
  const messageIds = new Set<string>();
  for (const ask of asks) messageIds.add(ask.messageId);
  for (const approval of approvals)
    if (approval.sessionMessageId) messageIds.add(approval.sessionMessageId);
  return messageIds;
}

/** The key a pending request is known by while it is being answered. */
export function requestKey(runId: string, requestId: string): string {
  return `${runId}:${requestId}`;
}

/**
 * `forYou` without the requests being answered (`requestKey`s): they leave
 * the badge, the pills and the panel at once, before the relay confirms. A
 * run left with nothing pending goes with them, and so does its message from
 * the focus. Returns `forYou` itself when nothing is hidden.
 */
export function withoutRequests(forYou: ForYou, hidden: ReadonlySet<string>): ForYou {
  if (hidden.size === 0) return forYou;
  let changed = false;
  const approvals: Approval[] = [];
  for (const approval of forYou.approvals) {
    const pending = approval.pending.filter(
      (p) => !hidden.has(requestKey(approval.runId, p.requestId))
    );
    if (pending.length === approval.pending.length) approvals.push(approval);
    else {
      changed = true;
      if (pending.length > 0) approvals.push({ ...approval, pending });
    }
  }
  if (!changed) return forYou;
  return { asks: forYou.asks, approvals, messageIds: messageIdsOf(forYou.asks, approvals) };
}

/** A message that is you speaking in the chat: your text, or your comment (never your agent's answer). */
function isYourWords(message: RoomMessage, selfUserId: string): boolean {
  if (message.authorId !== selfUserId) return false;
  if (message.meta.kind === 'text') return true;
  return message.meta.kind === 'comment_mirror' && !message.meta.replyFromAgent;
}

function computeAsks(
  snapshot: ForYouSnapshot,
  selfUserId: string,
  rows: readonly RigNotification[],
  dismissed: ReadonlySet<string>
): Ask[] {
  const byMessage = new Map<string, RigNotification[]>();
  for (const row of rows) {
    if (row.tier !== 'direct' || !ASK_TYPES.has(row.type) || !row.messageId) continue;
    if (row.actor.userId && row.actor.userId === selfUserId) continue;
    const list = byMessage.get(row.messageId) ?? [];
    list.push(row);
    byMessage.set(row.messageId, list);
  }
  if (byMessage.size === 0) return [];

  const loadedById = new Map(snapshot.messages.map((m) => [m.id, m]));
  const yours = snapshot.messages.filter((m) => isYourWords(m, selfUserId));
  const asks: Ask[] = [];

  for (const [messageId, list] of byMessage) {
    // Oldest row first: its id is the one the ask is dismissed by, and its facts describe the ask.
    const sorted = [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (sorted.some((r) => dismissed.has(r.id))) continue;
    const message = loadedById.get(messageId);
    const seq = message?.seq ?? sorted.find((r) => r.messageSeq !== null)?.messageSeq ?? null;
    const threadId = message?.threadId;
    const handled = yours.some((m) => {
      if (m.id === messageId) return false;
      // A quote-reply is later by nature (and a just-sent one shares the newest seq).
      if (m.meta.kind === 'text' && m.meta.replyTo?.id === messageId) return true;
      return threadId !== undefined && m.threadId === threadId && (seq === null || m.seq > seq);
    });
    if (handled) continue;
    const first = sorted[0]!;
    asks.push({
      notificationId: first.id,
      notificationIds: sorted.map((r) => r.id),
      type: first.type as Ask['type'],
      messageId,
      messageSeq: seq,
      loaded: message !== undefined,
      actor: first.actor,
      body: first.body,
      createdAt: first.createdAt,
    });
  }
  return asks.sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.messageId.localeCompare(b.messageId)
  );
}

function computeApprovals(
  snapshot: ForYouSnapshot,
  selfUserId: string,
  rows: readonly RigNotification[]
): Approval[] {
  const messageOfRun = new Map<string, string>();
  for (const m of snapshot.messages)
    if (m.meta.kind === 'session') messageOfRun.set(m.meta.runId, m.id);

  const approvals: Approval[] = [];
  for (const meta of Object.values(snapshot.sessionMetaByRun)) {
    if (meta.owner !== selfUserId) continue;
    // A run the relay already closed has no one left to answer.
    if (meta.status === 'done' || meta.status === 'failed' || meta.status === 'stopped') continue;
    const card = runCard(snapshot, meta.id);
    if (card.status === 'done' || card.status === 'failed' || card.status === 'stopped') continue;
    if (card.permissions.pending.length === 0) continue;
    approvals.push({
      runId: meta.id,
      sessionMessageId: messageOfRun.get(meta.id) ?? null,
      agent: meta.agent,
      askedBy: askedByOf(meta.id, meta.owner, snapshot, rows),
      pending: card.permissions.pending.map((p) => ({
        requestId: p.requestId,
        title: p.title,
        options: p.options,
      })),
    });
  }
  const startedAt = (a: Approval) =>
    Date.parse(snapshot.sessionMetaByRun[a.runId]?.startedAt ?? '');
  return approvals.sort(
    (a, b) => (startedAt(a) || 0) - (startedAt(b) || 0) || a.runId.localeCompare(b.runId)
  );
}

/**
 * Who asked for a run: a request or waiting row naming it carries the
 * requester. Without one, the owner: a Space only runs your own agent for
 * you, so unless a row says otherwise you asked yourself.
 */
function askedByOf(
  runId: string,
  owner: string,
  snapshot: ForYouSnapshot,
  rows: readonly RigNotification[]
): { id: string; name: string } {
  const named = rows.find(
    (r) => r.runId === runId && r.type === 'agent_request' && r.actor.kind !== 'agent'
  );
  const id = named?.actor.userId ?? owner;
  const name = named?.actor.name ?? snapshot.members.find((m) => m.id === id)?.name ?? 'You';
  return { id, name };
}

/**
 * The themes that hold something waiting on you (the blue dot on a pill).
 * A reply in a comment thread has no theme of its own: it counts under the
 * theme of the thread's first message, when `messages` (the Room's) says
 * which one that is.
 */
export function themesWithForYou(
  forYou: Pick<ForYou, 'messageIds'>,
  themeOf: Readonly<Record<string, { themeId: string }>>,
  messages: readonly Pick<RoomMessage, 'id' | 'seq' | 'threadId'>[] = []
): Set<string> {
  const byId = new Map<string, Pick<RoomMessage, 'id' | 'seq' | 'threadId'>>();
  const rootOf = new Map<string, string>();
  if ([...forYou.messageIds].some((id) => !themeOf[id])) {
    for (const m of messages) {
      byId.set(m.id, m);
      if (!m.threadId) continue;
      const root = rootOf.get(m.threadId);
      if (root === undefined || m.seq < byId.get(root)!.seq) rootOf.set(m.threadId, m.id);
    }
  }
  const themes = new Set<string>();
  for (const id of forYou.messageIds) {
    const threadId = byId.get(id)?.threadId;
    const assignment = themeOf[id] ?? (threadId ? themeOf[rootOf.get(threadId) ?? ''] : undefined);
    if (assignment) themes.add(assignment.themeId);
  }
  return themes;
}

/** Something that just showed up in For you, for the listener's notice. */
export type ForYouArrival =
  | { kind: 'ask'; key: string; ask: Ask }
  | { kind: 'approval'; key: string; approval: Approval; request: ApprovalRequest };

function itemsOf(forYou: ForYou): ForYouArrival[] {
  const items: ForYouArrival[] = [];
  for (const ask of forYou.asks) items.push({ kind: 'ask', key: `ask:${ask.messageId}`, ask });
  for (const approval of forYou.approvals) {
    for (const request of approval.pending) {
      items.push({
        kind: 'approval',
        key: `approval:${approval.runId}:${request.requestId}`,
        approval,
        request,
      });
    }
  }
  return items;
}

/**
 * What in `forYou` hasn't been seen before. `seen` is the keys already
 * counted, or null for the first look (what is there when the Room opens is
 * never an arrival): that look only fills the set. Returns the new set and
 * the arrivals, asks first then approvals. Keys are never forgotten, so an
 * item that leaves and comes back (a dismissal undone, a request re-listed
 * by a catch-up) does not announce itself twice.
 */
export function diffArrivals(
  seen: ReadonlySet<string> | null,
  forYou: ForYou
): { seen: Set<string>; arrivals: ForYouArrival[] } {
  const items = itemsOf(forYou);
  const next = new Set(seen ?? []);
  const arrivals: ForYouArrival[] = [];
  for (const item of items) {
    if (!next.has(item.key) && seen !== null) arrivals.push(item);
    next.add(item.key);
  }
  return { seen: next, arrivals };
}
