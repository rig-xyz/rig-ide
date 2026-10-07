import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowDown, ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { dayKey, dayStart, formatDayLabel } from '@renderer/lib/time-format';
import type { ConnectResult, GlobalServer } from '@shared/spaces/connectors';
import { effectiveRunStatus, runCard } from '../projection';
import { markReadThrough, readLastSeen } from '../room-read-marker';
import type { SearchPlan } from '../chat-search';
import { clearSearchMatches, paintSearchMatches } from '../search-highlight';
import type { ThreadSummary } from '../threads';
import { personOf } from '../person-identity';
import type { AgentKind, RoomMessage, RoomReplyRef, RoomSnapshot, SessionRunMeta } from '../types';
import { type MapEntry, ConversationMap } from './conversation-map';
import { AGENT_NAME } from './identity';
import { SessionCard, SessionCardPlaceholder } from './session-card';
import { ThreadReplyRow } from './thread-panel';
import {
  CommentMirrorLine,
  DayDivider,
  InviteRow,
  JoinRow,
  MessageRow,
  SystemRow,
  TypingRow,
} from './transcript-items';

/**
 * Spaces (lane 2): the Room transcript — a keyed list where new items fade
 * in. Rows don't animate their height: a streaming answer grows many times
 * a second, and re-animating every row around it made scrolling stutter.
 * While the reader is at the bottom, anything that grows the transcript
 * keeps them there (a ResizeObserver on the content, so a stream growing
 * inside one row counts, not just new rows). Scrolling up unpins; a pill
 * then counts what's new and jumps back down.
 */

const FOLLOW_THRESHOLD_PX = 60;
/** Scrolled within this of the top, the next older page loads. */
const LOAD_OLDER_THRESHOLD_PX = 240;
/** Scrolled past this, rows sit under the top bar (`topBar`): the same 4px Home's page uses. */
const SCROLLED_UNDER_BAR_PX = 4;
/** A jump pages back at most this far (50 messages a page) before saying the message is too far back. */
const JUMP_MAX_PAGES = 20;

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** A follow-up from the same person within this long drops its name and avatar, Slack-style. */
const CONTINUE_WITHIN_MS = 5 * 60_000;

/** A row's React key: your sending copy of a message and the relay's copy share its client id. */
function rowKey(message: RoomMessage): string {
  return message.clientId ?? message.id;
}

/** Who a row speaks as, for grouping follow-ups: a person, or one person's agent. */
function speakerOf(message: RoomMessage, snapshot: RoomSnapshot): string | null {
  if (message.meta.kind === 'text') return `person:${message.authorId}`;
  if (message.meta.kind === 'session') {
    const meta = snapshot.sessionMetaByRun[message.meta.runId];
    return meta ? `agent:${meta.agent}:${meta.owner}` : null;
  }
  return null;
}

export function isContinuation(prev: RoomMessage | undefined, message: RoomMessage, snapshot: RoomSnapshot): boolean {
  if (!prev || prev.threadId || message.threadId) return false;
  const speaker = speakerOf(message, snapshot);
  if (!speaker || speaker !== speakerOf(prev, snapshot)) return false;
  const gap = Date.parse(message.createdAt) - Date.parse(prev.createdAt);
  return gap >= 0 && gap < CONTINUE_WITHIN_MS && dayKey(prev.createdAt) === dayKey(message.createdAt);
}

/**
 * A run that hasn't produced anything yet while an earlier run of the same
 * person's same agent is still going: the dispatcher runs one turn at a
 * time per agent, so this one is waiting in line.
 */
function isQueued(meta: SessionRunMeta, snapshot: RoomSnapshot): boolean {
  if ((snapshot.sessionEventsByRun[meta.id] ?? []).length > 0 || snapshot.sessionSummaryByRun?.[meta.id]) return false;
  const running = (m: SessionRunMeta) => effectiveRunStatus(m.status, runCard(snapshot, m.id)) === 'running';
  if (!running(meta)) return false;
  return Object.values(snapshot.sessionMetaByRun).some(
    (other) =>
      other.id !== meta.id &&
      other.agent === meta.agent &&
      other.owner === meta.owner &&
      Date.parse(other.startedAt) < Date.parse(meta.startedAt) &&
      running(other)
  );
}

/** One message as the transcript draws it (the thread panel draws its messages the same way). */
export function renderItem(
  message: RoomMessage,
  snapshot: RoomSnapshot,
  ownId: string,
  onStopSession?: (runId: string) => Promise<boolean>,
  onResolvePermission?: (runId: string, requestId: string, optionId: string) => void,
  onOpenFile?: (relPath: string) => void,
  continued = false,
  onReply?: (ref: RoomReplyRef) => void,
  onJumpTo?: (messageId: string) => void,
  onRerun?: (agent: AgentKind, prompt: string) => void | Promise<boolean>,
  onConnectorConnect?: (id: string) => Promise<ConnectResult>,
  globalSetup?: GlobalServer[],
  onHideDetails?: (runId: string) => Promise<boolean>,
  onLoadRunLog?: (runId: string) => void
) {
  switch (message.meta.kind) {
    case 'text':
      return (
        <MessageRow
          message={message}
          snapshot={snapshot}
          ownId={ownId}
          continued={continued}
          onReply={onReply}
          onJumpTo={onJumpTo}
        />
      );
    case 'invite':
      return <InviteRow message={message} snapshot={snapshot} />;
    case 'comment_mirror':
      return <CommentMirrorLine message={message} snapshot={snapshot} onOpenFile={onOpenFile} />;
    case 'system':
      // 'member_joined' is the relay's (posted when an invite accept creates
      // a membership); 'joined' is the scripted demo's.
      if (message.meta.event === 'joined' || message.meta.event === 'member_joined') {
        return <JoinRow message={message} snapshot={snapshot} />;
      }
      // Day breaks are derived from timestamps (see RoomTranscript); a
      // scripted divider message would double them.
      if (message.meta.event === 'day_divider') return null;
      return <SystemRow message={message} snapshot={snapshot} onConnectorConnect={onConnectorConnect} />;
    case 'session': {
      const meta = snapshot.sessionMetaByRun[message.meta.runId];
      // Its log is still loading: hold its place (same row key, so the card replaces this in place).
      if (!meta) return snapshot.runsLoading?.[message.meta.runId] ? <SessionCardPlaceholder /> : null;
      const events = snapshot.sessionEventsByRun[message.meta.runId] ?? [];
      // Shown from disk: its summary until the log is fetched (on expand).
      const summary = events.length === 0 ? snapshot.sessionSummaryByRun?.[message.meta.runId] : undefined;
      const owner = snapshot.members.find((m) => m.id === meta.owner);
      // Stop is only ever offered for MY agent's own session — never a
      // teammate's, same "own agent only" rule the composer's @mention
      // dispatch already follows. `SessionCard` itself only renders the
      // button while the run is `running`.
      const canStop = onStopSession && meta.owner === ownId;
      // Same rule for approvals: only the owner answers their agent's asks.
      const canResolve = onResolvePermission && meta.owner === ownId;
      return (
        <SessionCard
          meta={meta}
          events={events}
          summary={summary}
          onLoadLog={summary && onLoadRunLog ? () => onLoadRunLog(meta.id) : undefined}
          owner={owner}
          viewerIsOwner={meta.owner === ownId}
          continued={continued}
          onOpenFile={onOpenFile}
          onReply={onReply}
          messageId={message.id}
          queued={isQueued(meta, snapshot)}
          onRerun={meta.owner === ownId ? onRerun : undefined}
          prompt={message.body}
          otherAgents={snapshot.agents
            .filter((a) => a.owner === ownId && a.agent !== meta.agent)
            .map((a) => a.agent)}
          onStop={canStop ? () => onStopSession(meta.id) : undefined}
          onResolvePermission={
            canResolve
              ? (requestId, optionId) => onResolvePermission(meta.id, requestId, optionId)
              : undefined
          }
          onConnectorConnect={meta.owner === ownId ? onConnectorConnect : undefined}
          spaceConnectors={snapshot.connectors}
          globalSetup={globalSetup}
          onHideDetails={onHideDetails && meta.owner === ownId ? () => onHideDetails(meta.id) : undefined}
          reactions={message.reactions}
          members={snapshot.members}
          ownId={ownId}
        />
      );
    }
    default:
      return null;
  }
}

/** One row of the transcript: a plain message, or a whole doc comment thread. */
type TranscriptUnit =
  | { kind: 'message'; message: RoomMessage }
  | { kind: 'thread'; threadId: string; messages: RoomMessage[] };

/**
 * Groups each doc comment thread (its first comment, the replies, and any
 * agent runs answering it) into one unit, placed where the thread was last
 * active so new replies surface at the bottom like any new message.
 */
export function groupThreads(messages: readonly RoomMessage[]): TranscriptUnit[] {
  const byThread = new Map<string, RoomMessage[]>();
  const lastIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.threadId) return;
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
    lastIndex.set(message.threadId, index);
  });
  const units: TranscriptUnit[] = [];
  messages.forEach((message, index) => {
    if (!message.threadId) {
      units.push({ kind: 'message', message });
    } else if (lastIndex.get(message.threadId) === index) {
      units.push({ kind: 'thread', threadId: message.threadId, messages: byThread.get(message.threadId)! });
    }
  });
  return units;
}

function unitKey(unit: TranscriptUnit): string {
  return unit.kind === 'message' ? unit.message.id : `thread-${unit.threadId}`;
}

function unitMessages(unit: TranscriptUnit): RoomMessage[] {
  return unit.kind === 'message' ? [unit.message] : unit.messages;
}

/**
 * A filter on the transcript: the units holding a focused message stay, and
 * the rest fold into one row each ("N messages in other themes"), which
 * opens in place. Without one the transcript is the whole conversation.
 */
export type TranscriptFocus = {
  /** A unit is kept when any message in it is here (a doc thread: its comment or any reply). */
  messageIds: ReadonlySet<string>;
  /**
   * 'chronological' (the default) keeps the conversation's own order and folds
   * each run of other units where it was. 'asks-first' pulls what is waiting
   * on you to the top: units holding an `askIds` message, then the other
   * kept ones, each in order, then one fold row for everything else.
   */
  order?: 'chronological' | 'asks-first';
  /** For 'asks-first': the kept messages that are asks of you. */
  askIds?: ReadonlySet<string>;
  /** The fold row's words for a run of `n` messages. */
  foldLabel: (n: number) => string;
  /** Drawn under a kept unit that holds an `askIds` message (given that message's id): the For you "Done". */
  askAccessory?: (messageId: string) => ReactNode;
  /**
   * Which focus this is (a theme's id, "for-you"). When it changes, opened
   * folds close and the view goes to the newest kept unit; without it the
   * `messageIds` set's identity stands in, so a caller that builds a new set
   * on every render must give a key.
   */
  key?: string;
};

type LayoutEntry =
  | {
      type: 'unit';
      unit: TranscriptUnit;
      /** Position in the conversation, to tell neighbours. */ index: number;
      dimmed: boolean;
      segment: number;
    }
  | { type: 'fold'; key: string; count: number; expanded: boolean };

/**
 * The rows of the transcript. No focus: every unit, as it is. With one: the
 * kept units, with each run of the others folded into one entry (or, once
 * opened, that entry followed by its units, dimmed). `segment` marks where
 * the day dividers start over (a reordered view isn't one timeline).
 */
export function layoutUnits(
  units: readonly TranscriptUnit[],
  focus: TranscriptFocus | undefined,
  opened: ReadonlySet<string>,
  snapshot: Pick<RoomSnapshot, 'sessionMetaByRun' | 'runsLoading'>
): { entries: LayoutEntry[]; foldOf: Map<string, string> } {
  const foldOf = new Map<string, string>();
  if (!focus) {
    return {
      entries: units.map((unit, index) => ({
        type: 'unit',
        unit,
        index,
        dimmed: false,
        segment: 0,
      })),
      foldOf,
    };
  }
  type Item = { unit: TranscriptUnit; index: number };
  const entries: LayoutEntry[] = [];
  const kept = (unit: TranscriptUnit) => unitMessages(unit).some((m) => focus.messageIds.has(m.id));
  const isAsk = (unit: TranscriptUnit) =>
    !!focus.askIds && unitMessages(unit).some((m) => focus.askIds!.has(m.id));
  const keep = (items: Item[], segment: number) => {
    for (const { unit, index } of items)
      entries.push({ type: 'unit', unit, index, dimmed: false, segment });
  };
  const fold = (run: Item[], segment: number) => {
    if (run.length === 0) return;
    // The count is what the transcript would show for these units, so a run that draws nothing has no row.
    const count = run.reduce((n, { unit }) => n + drawnCount(unit, snapshot), 0);
    if (count === 0) return;
    const key = `fold:${unitKey(run[0]!.unit)}`;
    const expanded = opened.has(key);
    entries.push({ type: 'fold', key, count, expanded });
    if (expanded) {
      for (const { unit, index } of run)
        entries.push({ type: 'unit', unit, index, dimmed: true, segment });
    } else {
      for (const { unit } of run) for (const m of unitMessages(unit)) foldOf.set(m.id, key);
    }
  };

  if (focus.order === 'asks-first') {
    const asks: Item[] = [];
    const rest: Item[] = [];
    const others: Item[] = [];
    units.forEach((unit, index) =>
      (isAsk(unit) ? asks : kept(unit) ? others : rest).push({ unit, index })
    );
    keep(asks, 0);
    keep(others, 1);
    fold(rest, 2);
  } else {
    let run: Item[] = [];
    units.forEach((unit, index) => {
      if (kept(unit)) {
        fold(run, 0);
        run = [];
        keep([{ unit, index }], 0);
      } else {
        run.push({ unit, index });
      }
    });
    fold(run, 0);
  }
  return { entries, foldOf };
}

/** Under a search match: where it sits, and the way back to it in the whole chat. */
function SearchRowFooter({ message, search }: { message: RoomMessage; search: TranscriptSearch }) {
  const label = search.contextLabel?.(message) ?? null;
  return (
    <div className="flex items-center justify-end gap-2 px-2 pt-1 text-2xs text-text-muted" data-search-skip>
      {label && <span data-testid="search-context-label">{label}</span>}
      <button
        type="button"
        onClick={() => search.onShowInChat(message)}
        className="rounded-control px-1.5 py-0.5 transition-colors hover:bg-bg-2 hover:text-text-primary"
        data-testid="search-show-in-chat"
      >
        Show in chat
      </button>
    </div>
  );
}

/** The row a run of folded units shows as: the day divider's look, and a button. */
function FoldRow({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-3 px-2 py-1.5 text-text-muted transition-colors hover:text-text-primary"
      data-testid={expanded ? 'transcript-fold-back' : 'transcript-fold'}
    >
      <span className="h-px flex-1 bg-border-hairline" />
      <span className="flex items-center gap-1 text-2xs">
        {expanded ? `Hide ${label}` : label}
        <Icon className="size-3" strokeWidth={1.5} />
      </span>
      <span className="h-px flex-1 bg-border-hairline" />
    </button>
  );
}

/** Replies shown before "Show N earlier replies"; the thread's first comment always shows. */
const THREAD_VISIBLE_REPLIES = 3;

/**
 * What a doc thread draws: its first comment, and the replies under it. When
 * the agent's run is in the thread, that row is its reply, so the mirrored copy
 * of the same answer is not drawn (it would only repeat it).
 */
function threadParts(
  threadId: string,
  messages: readonly RoomMessage[]
): { root: RoomMessage | undefined; rest: RoomMessage[] } {
  const root = messages.find((m) => m.id === threadId);
  const hasRun = messages.some((m) => m.meta.kind === 'session');
  const rest = messages.filter(
    (m) => m !== root && !(hasRun && m.meta.kind === 'comment_mirror' && m.meta.replyFromAgent)
  );
  return { root, rest };
}

/**
 * How many messages a unit shows, for a fold's count: a thread's drawn rows
 * (not the mirror lines it leaves out), and a lone message unless it draws
 * nothing (a day divider, a run whose log is not here).
 */
export function drawnCount(
  unit: TranscriptUnit,
  snapshot: Pick<RoomSnapshot, 'sessionMetaByRun' | 'runsLoading'>
): number {
  if (unit.kind === 'thread') {
    const { root, rest } = threadParts(unit.threadId, unit.messages);
    return (root ? 1 : 0) + rest.length;
  }
  const { meta } = unit.message;
  if (meta.kind === 'system' && meta.event === 'day_divider') return 0;
  if (
    meta.kind === 'session' &&
    !snapshot.sessionMetaByRun[meta.runId] &&
    !snapshot.runsLoading?.[meta.runId]
  )
    return 0;
  return 1;
}

/**
 * A doc comment thread as one block: the comment and its quoted passage on
 * top, then the replies and agent runs answering it, compact and in order.
 * Older replies fold behind a toggle; the latest few always show.
 */
function ThreadBlock({
  threadId,
  messages,
  renderMessage,
  renderReply,
}: {
  threadId: string;
  messages: RoomMessage[];
  renderMessage: (message: RoomMessage) => ReactNode;
  renderReply: (message: RoomMessage) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { root, rest } = threadParts(threadId, messages);
  const hidden = expanded ? 0 : Math.max(0, rest.length - THREAD_VISIBLE_REPLIES);
  const shown = rest.slice(hidden);
  return (
    // No outer card: a session card inside a bordered block reads as a card
    // in a card. The replies hang under the comment on a neutral hairline.
    <div className="flex flex-col gap-2" data-testid="comment-thread">
      {root && renderMessage(root)}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="ml-12 self-start text-xs text-text-muted transition-colors hover:text-text-primary"
          data-testid="thread-show-earlier"
        >
          Show {hidden} earlier {hidden === 1 ? 'reply' : 'replies'}
        </button>
      )}
      {shown.length > 0 && (
        // The hairline hangs from the root row's avatar; replies start on its text column.
        <div className="border-border-hairline ml-[22px] flex flex-col gap-2.5 border-l pl-[25px]">
          {shown.map((message) => (
            <div key={message.id}>
              {message.meta.kind === 'comment_mirror' ? renderReply(message) : renderMessage(message)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The conversation's rows as outline entries: people's messages, agent turns, doc threads. */
function mapEntriesFor(units: TranscriptUnit[], snapshot: RoomSnapshot, ownId: string): MapEntry[] {
  const nameOf = (id: string) => personOf(snapshot, id).name;
  const entries: MapEntry[] = [];
  for (const unit of units) {
    if (unit.kind === 'thread') {
      const root = unit.messages[0];
      if (!root) continue;
      const path = root.meta.kind === 'comment_mirror' ? root.meta.path : 'a doc';
      entries.push({
        id: unit.threadId,
        tone: 'other',
        label: `${nameOf(root.authorId)} on ${path} · ${root.time}`,
        preview: () => root.body ?? '',
      });
      continue;
    }
    const m = unit.message;
    if (m.meta.kind === 'text') {
      entries.push({
        id: m.id,
        tone: m.authorId === ownId ? 'mine' : 'person',
        label: `${m.authorId === ownId ? 'You' : nameOf(m.authorId)} · ${m.time}`,
        preview: () => m.body ?? '',
      });
    } else if (m.meta.kind === 'session') {
      const meta = snapshot.sessionMetaByRun[m.meta.runId];
      if (!meta) continue;
      entries.push({
        id: m.id,
        tone: 'agent',
        label: `${meta.owner === ownId ? 'Your' : `${nameOf(meta.owner)}'s`} ${AGENT_NAME[meta.agent]} · ${m.time}`,
        preview: () => {
          const card = runCard(snapshot, meta.id);
          return card.finalAnswer || (card.reacted.length > 0 ? `Reacted ${card.reacted.join(' ')}` : 'Working…');
        },
      });
    }
  }
  return entries;
}

/** Threads view: the reply row under each root that has replies, and which thread is open. */
export type TranscriptThreads = {
  summaries: ReadonlyMap<string, ThreadSummary>;
  openRootId: string | null;
  onOpen: (rootId: string) => void;
};

/**
 * The transcript as a chat search's results (`RoomView` draws a second one
 * over the chat while a query is in): `snapshot.messages` holds only the
 * matches, each with the match highlighted and a "Show in chat" under it.
 * No "New" line, no conversation map, nothing marked read.
 */
export type TranscriptSearch = {
  plan: SearchPlan;
  /** Back to the whole chat, at this message. */
  onShowInChat: (message: RoomMessage) => void;
  /** Where a match sits, said beside its "Show in chat" (Threads view: a reply is "In a thread"). */
  contextLabel?: (message: RoomMessage) => string | null;
};

export type RoomJumpRequest = {
  messageId?: string | null;
  /** Lets a jump to a message older than the loaded window give up at once, and say so. */
  messageSeq?: number | null;
  runId?: string | null;
  nonce: number;
};

export function RoomTranscript({
  snapshot,
  ownId,
  onStopSession,
  onResolvePermission,
  onOpenFile,
  onReply,
  readKey,
  onRerun,
  onConnectorConnect,
  globalSetup,
  onHideDetails,
  onLoadRunLog,
  jump = null,
  onJumpMissed,
  onLoadOlder,
  focus,
  previewIds,
  topBar,
  threads,
  readThroughSeq,
  search,
}: {
  snapshot: RoomSnapshot;
  ownId: string;
  onStopSession?: (runId: string) => Promise<boolean>;
  onResolvePermission?: (runId: string, requestId: string, optionId: string) => void;
  /** Opens a space file (relative path) in the editor, e.g. from a doc comment line. */
  onOpenFile?: (relPath: string) => void;
  /** Starts a quote-reply in the composer. */
  onReply?: (ref: RoomReplyRef) => void;
  /** Where to remember how far the viewer has read (the space's id); no "New" line without one. */
  readKey?: string;
  /** Files a new turn for one of the viewer's own agents (Retry, Continue); resolves false when it couldn't. */
  onRerun?: (agent: AgentKind, prompt: string) => void | Promise<boolean>;
  /** Runs the connect flow for a connector's Connect/Reconnect pill (a `connectors_added` card, or an agent turn's footer gap). */
  onConnectorConnect?: (id: string) => Promise<ConnectResult>;
  /** Your agents' own global MCP setup, loaded once per Room by `RoomView` — a session card drops a footer gap its own run's agent already reaches this way. */
  globalSetup?: GlobalServer[];
  /** "Hide details" on one of the viewer's own finished runs. Resolves false if it couldn't. */
  onHideDetails?: (runId: string) => Promise<boolean>;
  /** A run shown from the disk cache (a summary only): fetch its log, when its card is expanded. */
  onLoadRunLog?: (runId: string) => void;
  /**
   * Notifications: scroll to a message (or a run's card) once it's here, as
   * a banner or Activity click asks. A new `nonce` asks again.
   */
  jump?: RoomJumpRequest | null;
  /** The jump's message couldn't be reached (before the start, or past the paging cap). */
  onJumpMissed?: () => void;
  /** Scrollback: load the page before the oldest message (`RoomSource.loadOlder`). */
  onLoadOlder?: () => void;
  /** Show only what matters: a theme's messages, or what is waiting on you. Absent: everything. */
  focus?: TranscriptFocus;
  /**
   * A dock pill is hovered: these messages stay as they are and every other
   * row dims (`data-preview-dimmed`), so the reader sees what the pill holds
   * without the transcript moving. Absent: nothing is dimmed.
   */
  previewIds?: ReadonlySet<string> | null;
  /**
   * The app's bare top bar overlays the 40px above this transcript: the
   * scroll view reaches up beneath it (its first row still starts clear of
   * it), and `onScrolled` says whether anything has scrolled under it, so
   * the bar can blur. Absent: no bar overlays the transcript.
   */
  topBar?: { onScrolled: (scrolled: boolean) => void };
  /** Threads view: `snapshot` holds the main column only, and each root with replies gets its reply row. */
  threads?: TranscriptThreads;
  /**
   * How far reading to the bottom marks the space read, when the snapshot
   * isn't the whole conversation (Threads view: replies folded into threads
   * count as read with the main column, as a channel's thread replies do).
   */
  readThroughSeq?: number;
  /** Draw the search results instead of the chat (see `TranscriptSearch`). */
  search?: TranscriptSearch;
}) {
  // Callbacks read through refs: a parent's fresh arrow each render must
  // not re-run the scroll listener or the jump.
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const onScrolledRef = useRef(topBar?.onScrolled);
  onScrolledRef.current = topBar?.onScrolled;
  const onJumpMissedRef = useRef(onJumpMissed);
  onJumpMissedRef.current = onJumpMissed;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Pinned = the reader is at the bottom, so new content keeps them there.
  // Scrolling up unpins; coming back near the bottom re-pins.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const reducedMotion = useReducedMotion();

  // Calm Room open: every message id already here the moment this transcript
  // first mounts (a full, already-loaded snapshot — see `RelayRoomSource`'s
  // own batched bootstrap) never animates in; only a row whose message
  // wasn't in `seenIds` yet gets the enter animation. Read during render
  // (reflects the PREVIOUS commit's ids), written after in the effect below
  // — same timing trick `lastCountRef` below already relies on — so a row's
  // very first render sees it as new, and every later re-render doesn't.
  const [seenIds] = useState(() => new Set(snapshot.messages.map(rowKey)));
  useEffect(() => {
    for (const m of snapshot.messages) seenIds.add(rowKey(m));
  }, [snapshot.messages, seenIds]);

  const focusRef = useRef(focus);
  focusRef.current = focus;

  const pinToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    setUnseen(0);
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // Folds the reader opened, for the focus they opened them under: another focus closes them.
  const focusId: unknown = focus ? (focus.key ?? focus.messageIds) : null;
  const [openState, setOpenState] = useState<{ focusId: unknown; keys: ReadonlySet<string> }>({
    focusId,
    keys: new Set(),
  });
  const opened = openState.focusId === focusId ? openState.keys : EMPTY_KEYS;
  const setFold = (key: string, open: boolean) =>
    setOpenState((prev) => {
      const keys = new Set(prev.focusId === focusId ? prev.keys : []);
      if (open) keys.add(key);
      else keys.delete(key);
      return { focusId, keys };
    });
  // Which fold hides which message, from the latest render: a jump into one opens it first.
  const foldOfRef = useRef<Map<string, string>>(new Map());
  const pendingJumpRef = useRef<string | null>(null);

  const jumpTo = (messageId: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) {
      const foldKey = foldOfRef.current.get(messageId);
      if (foldKey && !opened.has(foldKey)) {
        pendingJumpRef.current = messageId;
        setFold(foldKey, true);
      }
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Ring just the message itself (a person's bubble, an agent's answer), not the whole row.
    const focus = target.querySelector<HTMLElement>('[data-highlight-target]') ?? target;
    focus.animate(
      [
        { boxShadow: '0 0 0 2px var(--accent), 0 0 0 6px var(--accent-subtle)' },
        { boxShadow: '0 0 0 2px transparent, 0 0 0 6px transparent' },
      ],
      { duration: 1600, easing: 'ease-out' }
    );
  };

  // A jump waits for its message: the Room may still be loading when the
  // click lands. Done once per request; gives up quietly if the message
  // never shows (deleted, or older than what the Room loads).
  const jumpDoneRef = useRef<number | null>(null);
  const jumpPagesRef = useRef<{ nonce: number; pages: number }>({ nonce: -1, pages: 0 });
  useEffect(() => {
    if (!jump || jumpDoneRef.current === jump.nonce) return;
    const messageId =
      jump.messageId ??
      (jump.runId
        ? snapshot.messages.find((m) => m.meta.kind === 'session' && m.meta.runId === jump.runId)?.id
        : undefined);
    if (!messageId || !snapshot.messages.some((m) => m.id === messageId)) {
      // Loaded, and the message is from before the oldest one here: page
      // back toward it (scrollback), a bounded number of pages. Past the
      // start of the space, or the cap, say so rather than open silently.
      const oldest = snapshot.messages.length > 0 ? Math.min(...snapshot.messages.map((m) => m.seq)) : null;
      if (snapshot.stale || jump.messageSeq == null || oldest === null || jump.messageSeq >= oldest) return;
      if (jumpPagesRef.current.nonce !== jump.nonce) jumpPagesRef.current = { nonce: jump.nonce, pages: 0 };
      if (snapshot.olderMessages === 'loading') return;
      if (snapshot.olderMessages === 'more' && onLoadOlderRef.current && jumpPagesRef.current.pages < JUMP_MAX_PAGES) {
        jumpPagesRef.current.pages += 1;
        onLoadOlderRef.current();
        return;
      }
      jumpDoneRef.current = jump.nonce;
      onJumpMissedRef.current?.();
      return;
    }
    jumpDoneRef.current = jump.nonce;
    pinnedRef.current = false;
    setPinned(false);
    requestAnimationFrame(() => jumpTo(messageId));
    // `jumpTo` only reads refs; the callbacks are read through refs too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, snapshot.messages, snapshot.stale, snapshot.olderMessages]);

  // A jump that had to open a fold waits for the unit to render, then goes.
  useLayoutEffect(() => {
    const messageId = pendingJumpRef.current;
    if (!messageId) return;
    pendingJumpRef.current = null;
    requestAnimationFrame(() => jumpTo(messageId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  // Another focus (or none): back to the newest unit it keeps, which is
  // where the end of the view is (a fold row at most beneath it).
  const prevFocusIdRef = useRef(focusId);
  useLayoutEffect(() => {
    if (prevFocusIdRef.current === focusId) return;
    prevFocusIdRef.current = focusId;
    pinToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      onScrolledRef.current?.(el.scrollTop > SCROLLED_UNDER_BAR_PX);
      if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) onLoadOlderRef.current?.();
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
      if (atBottom === pinnedRef.current) return;
      pinnedRef.current = atBottom;
      setPinned(atBottom);
      if (atBottom) setUnseen(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScrolledRef.current?.(el.scrollTop > SCROLLED_UNDER_BAR_PX);
    return () => {
      el.removeEventListener('scroll', onScroll);
      // Nothing of this transcript is under the bar once it's gone.
      onScrolledRef.current?.(false);
    };
  }, []);

  // Anything that grows the transcript (a new row, a streaming answer, a
  // step landing) keeps a pinned reader at the bottom, instantly: smooth
  // scrolls chasing a stream lag behind and stutter.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    el.scrollTop = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // A new snapshot (a card's log landing in place of its placeholder, a row
  // added) re-pins before paint, not whenever the observer above gets round
  // to it: under load that could be late enough for the reader to see the
  // bottom slide away.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [snapshot]);

  // Scrollback: a page landing above must not move what the reader is
  // looking at. The height is read during render (the DOM still shows the
  // previous page then) and the difference is added back before paint.
  const firstId = snapshot.messages[0]?.id ?? null;
  const prevFirstIdRef = useRef(firstId);
  const heightBeforeRef = useRef(0);
  if (firstId !== prevFirstIdRef.current && scrollRef.current) {
    heightBeforeRef.current = scrollRef.current.scrollHeight;
  }
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prevFirst = prevFirstIdRef.current;
    prevFirstIdRef.current = firstId;
    if (!el || pinnedRef.current || prevFirst === null || firstId === prevFirst) return;
    // Only a prepend: the old first message is still here, further down.
    if (!snapshot.messages.some((m) => m.id === prevFirst)) return;
    el.scrollTop += el.scrollHeight - heightBeforeRef.current;
  }, [firstId, snapshot.messages]);

  // Too few messages to scroll, yet more above: ask for them without a scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && snapshot.olderMessages === 'more' && el.scrollHeight <= el.clientHeight) onLoadOlder?.();
  }, [snapshot.olderMessages, snapshot.messages.length, onLoadOlder]);

  // New messages while scrolled up are counted for the jump-back pill; one
  // you sent yourself always brings you back down.
  // Counted after the previous last message, not by length: an older page
  // prepended by scrollback isn't new.
  const lastIdRef = useRef(snapshot.messages[snapshot.messages.length - 1]?.id ?? null);
  useEffect(() => {
    const lastAt = lastIdRef.current === null ? -1 : snapshot.messages.findIndex((m) => m.id === lastIdRef.current);
    const added = snapshot.messages.slice(lastAt + 1);
    lastIdRef.current = snapshot.messages[snapshot.messages.length - 1]?.id ?? null;
    if (added.length === 0) return;
    if (added.some((m) => m.authorId === ownId && m.meta.kind === 'text')) {
      pinToBottom();
      return;
    }
    // Under a focus, what lands in the folded rest isn't something to jump down to.
    const f = focusRef.current;
    const shown = f ? added.filter((m) => f.messageIds.has(m.id)) : added;
    if (!pinnedRef.current && shown.length > 0) setUnseen((n) => n + shown.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.messages]);

  // Where you left off: the first message from someone else after the last
  // one you'd scrolled to, fixed for this visit (Slack's "New" line).
  const [newFromId, setNewFromId] = useState<string | null>(null);
  const markedRef = useRef(false);
  // Shown from disk (`stale`), it waits for the catch-up: what came in since is exactly what's new.
  const stale = snapshot.stale === true;
  useEffect(() => {
    if (!readKey || markedRef.current || stale || snapshot.messages.length === 0) return;
    markedRef.current = true;
    const lastRead = readLastSeen(readKey);
    if (lastRead === null) return;
    const first = snapshot.messages.find((m) => m.seq > lastRead && m.authorId !== ownId);
    if (first) setNewFromId(first.id);
  }, [readKey, snapshot.messages, ownId, stale]);
  useEffect(() => {
    // Nor is anything marked read before then: the marker would skip what's new.
    // Under a focus the rest is folded away, not read.
    if (!readKey || !pinned || stale || focusId !== null || snapshot.messages.length === 0) return;
    markReadThrough(readKey, readThroughSeq ?? Math.max(...snapshot.messages.map((m) => m.seq)));
  }, [readKey, pinned, snapshot.messages, stale, focusId, readThroughSeq]);

  // Search: the matches are highlighted wherever they render, again as rows
  // change (a card's log landing, a page of older matches coming in).
  const searchPlan = search?.plan ?? null;
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !searchPlan) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      paintSearchMatches(content, searchPlan);
    };
    paint();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(paint);
    });
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearSearchMatches();
    };
  }, [searchPlan]);

  // Split-resize perf round: `groupThreads` used to run twice a render —
  // once here, once again inline below to build the actual rows — so any
  // re-render this component takes for a reason that has nothing to do
  // with new messages (a window/split resize bubbling down from `RoomView`,
  // say) grouped the same messages over again for no reason. One pass,
  // shared by both.
  const units = useMemo(() => groupThreads(snapshot.messages), [snapshot.messages]);
  const { sessionMetaByRun, runsLoading } = snapshot;
  const layout = useMemo(
    () => layoutUnits(units, focus, opened, { sessionMetaByRun, runsLoading }),
    [units, focus, opened, sessionMetaByRun, runsLoading]
  );
  foldOfRef.current = layout.foldOf;
  const newIndex = useMemo(
    () => (newFromId ? units.findIndex((u) => unitMessages(u).some((m) => m.id === newFromId)) : -1),
    [units, newFromId]
  );
  const mapEntries = useMemo(() => mapEntriesFor(units, snapshot, ownId), [units, snapshot, ownId]);

  const agentWorking = Object.values(snapshot.sessionMetaByRun).some(
    (meta) =>
      meta.status === 'running' &&
      !snapshot.sessionSummaryByRun?.[meta.id] && // a summary is a finished run's
      snapshot.sessionEventsByRun[meta.id]?.every((e) => e.kind !== 'turn_ended')
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <motion.div
      ref={scrollRef}
      // Under the bare top bar, the scroll view reaches up 40px beneath it.
      className={cn('min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]', topBar && '-mt-10')}
      data-testid="room-transcript"
      // Calm Room open: the whole, already-scrolled-to-bottom transcript
      // fades in once on mount (masking the non-smooth scroll-to-bottom
      // that happens in the same tick, below) — never per row.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Extra bottom clearance (vs. the top/side padding) so the "N new
          messages" pill below has room to float without covering the last
          row — it's positioned relative to this same scroll viewport. */}
      <div
        ref={contentRef}
        // Search results start clear of the search field above them.
        className={cn('relative mx-auto flex max-w-[44rem] flex-col gap-4 px-3 pb-12', topBar || search ? 'pt-16' : 'pt-6')}
      >
        {snapshot.olderMessages === 'loading' && (
          <p className="text-text-muted text-center text-xs" data-testid="room-older-loading">
            {search ? 'Loading older matches…' : 'Loading earlier messages…'}
          </p>
        )}
        {snapshot.olderMessages === 'none' && snapshot.messages.length > 0 && !search && (
          <p className="text-text-muted text-center text-xs" data-testid="room-start">
            Start of the space
          </p>
        )}
        <AnimatePresence initial={false}>
          {(() => {
            const nodes: ReactNode[] = [];
            let lastDay = Number.NEGATIVE_INFINITY;
            let lastSegment = -1;
            let prevMessage: RoomMessage | undefined;
            let prevIndex = -2;
            let newShown = false;
            for (const entry of layout.entries) {
              if (entry.type === 'fold') {
                nodes.push(
                  <div key={entry.key}>
                    <FoldRow
                      label={focus!.foldLabel(entry.count)}
                      expanded={entry.expanded}
                      onToggle={() => setFold(entry.key, !entry.expanded)}
                    />
                  </div>
                );
                prevMessage = undefined;
                continue;
              }
              const { unit, index, dimmed, segment } = entry;
              // A reordered view isn't one timeline: its day dividers start over in each part.
              if (segment !== lastSegment) {
                lastSegment = segment;
                lastDay = Number.NEGATIVE_INFINITY;
              }
              // "New" goes above the first row shown from the first new one on: a hidden
              // first-new unit passes it to the next shown one, never a fold. A reordered view has no "new".
              if (newFromId && !newShown && newIndex >= 0 && index >= newIndex && focus?.order !== 'asks-first') {
                newShown = true;
                nodes.push(
                  <div key="new-divider" className="flex items-center gap-3 px-2 py-1.5" data-testid="new-divider">
                    <span className="bg-accent/50 h-px flex-1" />
                    <span className="text-accent text-2xs font-medium">New</span>
                  </div>
                );
              }
              // A thread sits where it was last active, so its day is its latest message's.
              const placed = unit.kind === 'message' ? unit.message : unit.messages.at(-1);
              const day = placed ? dayStart(placed.createdAt) : Number.NaN;
              // Only ever step forward: an out-of-order item never re-opens an earlier day.
              if (placed && day > lastDay) {
                lastDay = day;
                nodes.push(
                  <motion.div key={`day-${segment}-${day}`}>
                    <DayDivider label={formatDayLabel(placed.createdAt)} />
                  </motion.div>
                );
              }
              const render = (message: RoomMessage, continued = false) =>
                renderItem(
                  message,
                  snapshot,
                  ownId,
                  onStopSession,
                  onResolvePermission,
                  onOpenFile,
                  continued,
                  onReply,
                  jumpTo,
                  onRerun,
                  onConnectorConnect,
                  globalSetup,
                  onHideDetails,
                  onLoadRunLog
                );
              // Only a follow-up when it truly follows: a fold or a reorder in between breaks the run.
              const continuedUnit =
                unit.kind === 'message' && index === prevIndex + 1 && isContinuation(prevMessage, unit.message, snapshot);
              const node =
                unit.kind === 'message' ? (
                  render(unit.message, continuedUnit)
                ) : (
                  <ThreadBlock
                    threadId={unit.threadId}
                    messages={unit.messages}
                    renderMessage={(message) => render(message)}
                    renderReply={(message) => (
                      <CommentMirrorLine message={message} snapshot={snapshot} onOpenFile={onOpenFile} inThread />
                    )}
                  />
                );
              prevMessage = unit.kind === 'message' ? unit.message : undefined;
              prevIndex = index;
              if (!node) continue;
              // Calm Room open: a row whose message was already in the
              // snapshot the moment this transcript mounted never animates
              // (`initial={false}`) — only a genuinely new one does, with a
              // short fade + 4px rise. `seenIds` starts pre-loaded with
              // every id from that first mount (see above), so the whole
              // initial batch reads as "already seen."
              const isNewRow = !!placed && !seenIds.has(rowKey(placed));
              const previewDimmed =
                !!previewIds && !unitMessages(unit).some((m) => previewIds.has(m.id));
              const askMessageId = focus?.askIds
                ? unitMessages(unit).find((m) => focus.askIds!.has(m.id))?.id
                : undefined;
              nodes.push(
                <motion.div
                  // Your sending copy and the relay's share a key: the one bubble turns solid in place.
                  key={unit.kind === 'message' ? rowKey(unit.message) : unitKey(unit)}
                  data-message-id={unit.kind === 'message' ? unit.message.id : unit.threadId}
                  data-row-entered={isNewRow ? 'true' : undefined}
                  data-dimmed={dimmed ? 'true' : undefined}
                  data-preview-dimmed={previewDimmed ? 'true' : undefined}
                  // Room between speakers; a follow-up from the same one sits close.
                  className={cn('rounded-card', continuedUnit && '-mt-3')}
                  initial={isNewRow ? { opacity: 0, y: 4 } : false}
                  animate={{ opacity: previewDimmed ? 0.28 : dimmed ? 0.55 : 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : previewIds ? 0.25 : 0.16, ease: [0.16, 1, 0.3, 1] }}
                >
                  {node}
                  {threads &&
                    unitMessages(unit).map((m) => {
                      const summary = threads.summaries.get(m.id);
                      return summary ? (
                        <ThreadReplyRow
                          key={`thread-${m.id}`}
                          summary={summary}
                          members={snapshot.members}
                          mine={m.authorId === ownId && m.meta.kind === 'text'}
                          open={threads.openRootId === m.id}
                          onOpen={() => threads.onOpen(m.id)}
                        />
                      ) : null;
                    })}
                  {askMessageId !== undefined && focus?.askAccessory?.(askMessageId)}
                  {search && placed && <SearchRowFooter message={placed} search={search} />}
                </motion.div>
              );
            }
            return nodes;
          })()}
          {snapshot.typingUserIds.length > 0 && (
            <motion.div
              key="typing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <TypingRow personIds={snapshot.typingUserIds} snapshot={snapshot} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
      {!search && <ConversationMap scrollRef={scrollRef} contentRef={contentRef} entries={mapEntries} onJump={jumpTo} />}
      {/* Whenever you've scrolled up (Dylan, 2026-09-26): a round down arrow
          when nothing's new, the labelled pill when something is. */}
      {!pinned && (
        <button
          type="button"
          onClick={() => pinToBottom('smooth')}
          aria-label="Go to the latest message"
          title="Go to the latest message"
          className={cn(
            'card-pop-in border-border-hairline bg-bg-1 shadow-float hover:bg-bg-2 absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center rounded-chip border text-xs text-text-primary transition-colors',
            unseen > 0 || agentWorking ? 'gap-2 px-3' : 'w-8 justify-center'
          )}
          data-testid="jump-to-latest"
        >
          {agentWorking && <DotMatrix state="thinking" size="sm" />}
          {unseen > 0 ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : agentWorking ? 'Jump to latest' : null}
          <ArrowDown className={cn('size-3.5', unseen > 0 || agentWorking ? 'text-text-muted' : 'text-text-secondary')} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
