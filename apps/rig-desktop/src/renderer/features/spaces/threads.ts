import type { TranscriptFocus } from './components/room-transcript';
import type { AgentKind, RoomMessage, RoomSnapshot } from './types';

/**
 * Threads view (Settings › Spaces › Chat view): a thread is a message plus
 * every reply to it. A reply to a reply belongs to its parent's thread, so
 * nothing nests deeper than one level. The main column shows the roots; a
 * thread's replies open beside it. Pure: built from the message list alone.
 *
 * What links a message to the one it answers:
 *  - a text reply: `meta.replyTo.id`;
 *  - an agent run: `meta.sourceMessageId`, the message that asked for it,
 *    when that message is itself in a thread. A run asked from a root stays
 *    in the main column, as the answer everyone sees. Sessions posted
 *    without it (every run today: see `startTurn` in the dispatcher) stay
 *    in the main column too.
 *
 * Scrollback: a reply whose root isn't loaded yet stays in the main column,
 * as Flow shows it (its quote line says what it answers), until the root
 * comes in with an older page.
 */

export type ReplyThread = {
  root: RoomMessage;
  /** In the order they were sent. */
  replies: RoomMessage[];
};

export type ThreadsLayout = {
  /** What the main column shows, in order: roots, replies whose root isn't loaded, and replies also sent to the main column. */
  main: RoomMessage[];
  /** Every message that starts a thread (or could): what Reply opens a thread on. */
  roots: ReadonlySet<string>;
  /** Threads with at least one reply, by their root's id. */
  threads: ReadonlyMap<string, ReplyThread>;
  /** Each reply's root. */
  rootOf: ReadonlyMap<string, string>;
};

/** The message this one answers, if it says. */
function parentIdOf(message: RoomMessage): string | undefined {
  if (message.meta.kind === 'text') return message.meta.replyTo?.id;
  if (message.meta.kind === 'session') return message.meta.sourceMessageId;
  return undefined;
}

export function buildThreads(messages: readonly RoomMessage[]): ThreadsLayout {
  const byId = new Map(messages.map((m) => [m.id, m]));
  // A message's root: itself (it starts a thread), another message's id (it's
  // a reply in that thread), or null (it answers a message that isn't loaded).
  const memo = new Map<string, string | null>();
  const visiting = new Set<string>();
  const rootIdOf = (message: RoomMessage): string | null => {
    const known = memo.get(message.id);
    if (known !== undefined) return known;
    if (visiting.has(message.id)) return null; // a loop: never trust it
    visiting.add(message.id);
    let root: string | null;
    const parentId = parentIdOf(message);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (message.meta.kind === 'session') {
      // A run joins a thread only through a reply that asked for it; asked from a root, it answers in the main column.
      const via = parent && parentIdOf(parent) !== undefined ? rootIdOf(parent) : message.id;
      root = via === parent?.id ? message.id : via;
    } else if (!parentId) {
      root = message.id;
    } else {
      root = parent ? rootIdOf(parent) : null;
    }
    visiting.delete(message.id);
    memo.set(message.id, root);
    return root;
  };

  const main: RoomMessage[] = [];
  const roots = new Set<string>();
  const threads = new Map<string, ReplyThread>();
  const rootOf = new Map<string, string>();
  for (const message of messages) {
    const root = rootIdOf(message);
    if (root === message.id) {
      roots.add(message.id);
      main.push(message);
      continue;
    }
    if (root === null) {
      main.push(message);
      continue;
    }
    rootOf.set(message.id, root);
    const thread = threads.get(root) ?? { root: byId.get(root)!, replies: [] };
    thread.replies.push(message);
    threads.set(root, thread);
    if (message.meta.kind === 'text' && message.meta.alsoInChannel) main.push(message);
  }
  return { main, roots, threads, rootOf };
}

/** The thread Reply on this message opens: its own, or the one it's a reply in; null when its thread isn't loaded. */
export function threadRootFor(layout: ThreadsLayout, messageId: string): string | null {
  return layout.rootOf.get(messageId) ?? (layout.roots.has(messageId) ? messageId : null);
}

export type ThreadFace = { kind: 'person'; id: string } | { kind: 'agent'; agent: AgentKind; owner: string };

export type ThreadSummary = {
  count: number;
  /** Who replied, newest first, at most three. */
  faces: ThreadFace[];
  /** The newest reply. */
  last: RoomMessage;
  /** An agent working in the thread right now. */
  working: AgentKind | null;
  /** Replies from others you haven't seen. */
  unread: number;
};

const MAX_FACES = 3;

/**
 * The reply row under a root: how many replies, who, when the last one came,
 * an agent at work in it, and how many you haven't seen. `seenSeq`: the
 * newest reply you've seen (null: none); `isRunning` says whether a run is
 * live (the session projection decides, outside this module).
 */
export function summarizeThread(
  thread: ReplyThread,
  snapshot: Pick<RoomSnapshot, 'sessionMetaByRun'>,
  ownId: string,
  seenSeq: number | null,
  isRunning: (runId: string) => boolean
): ThreadSummary {
  const faces: ThreadFace[] = [];
  const seen = new Set<string>();
  let working: AgentKind | null = null;
  let unread = 0;
  for (let i = thread.replies.length - 1; i >= 0; i -= 1) {
    const reply = thread.replies[i]!;
    const run = reply.meta.kind === 'session' ? snapshot.sessionMetaByRun[reply.meta.runId] : undefined;
    if (run && !working && isRunning(run.id)) working = run.agent;
    const face: ThreadFace | null = run
      ? { kind: 'agent', agent: run.agent, owner: run.owner }
      : reply.meta.kind === 'session'
        ? null
        : { kind: 'person', id: reply.authorId };
    const key = face ? (face.kind === 'agent' ? `agent:${face.agent}:${face.owner}` : `person:${face.id}`) : null;
    if (face && key && !seen.has(key) && faces.length < MAX_FACES) {
      seen.add(key);
      faces.push(face);
    }
    if (reply.authorId !== ownId && !reply.sending && (seenSeq === null || reply.seq > seenSeq)) unread += 1;
  }
  return { count: thread.replies.length, faces, last: thread.replies.at(-1)!, working, unread };
}

/** The newest reply's seq: what opening the thread marks seen. */
export function newestSeq(thread: ReplyThread): number {
  return thread.replies.reduce((max, m) => (m.sending ? max : Math.max(max, m.seq)), thread.root.seq);
}

/**
 * A dock focus, for the main column in Threads view. A topic applies to
 * roots: a thread goes with its root's topic, and a reply's own topic
 * doesn't pull its root in. An ask of you that's a reply raises its thread's
 * root, and the root's "Done" answers that ask.
 */
export function focusForThreads(focus: TranscriptFocus | undefined, layout: ThreadsLayout): TranscriptFocus | undefined {
  if (!focus) return focus;
  const shown = new Set(layout.main.map((m) => m.id));
  const messageIds = new Set<string>();
  for (const id of focus.messageIds) if (shown.has(id) || !layout.rootOf.has(id)) messageIds.add(id);
  if (!focus.askIds) return { ...focus, messageIds };
  const askIds = new Set<string>();
  const askOfRoot = new Map<string, string>();
  for (const id of focus.askIds) {
    const root = shown.has(id) ? undefined : layout.rootOf.get(id);
    if (!root) {
      askIds.add(id);
      continue;
    }
    askIds.add(root);
    messageIds.add(root);
    if (!askOfRoot.has(root)) askOfRoot.set(root, id);
  }
  const accessory = focus.askAccessory;
  return {
    ...focus,
    messageIds,
    askIds,
    ...(accessory ? { askAccessory: (id: string) => accessory(askOfRoot.get(id) ?? id) } : {}),
  };
}
