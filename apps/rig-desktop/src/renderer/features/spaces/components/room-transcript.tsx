import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { dayKey, dayStart, formatDayLabel } from '@renderer/lib/time-format';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { AgentKind, RoomMessage, RoomReplyRef, RoomSnapshot, SessionRunMeta } from '../types';
import { type MapEntry, ConversationMap } from './conversation-map';
import { AGENT_NAME } from './identity';
import { SessionCard } from './session-card';
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

/** A follow-up from the same person within this long drops its name and avatar, Slack-style. */
const CONTINUE_WITHIN_MS = 5 * 60_000;

/** Who a row speaks as, for grouping follow-ups: a person, or one person's agent. */
function speakerOf(message: RoomMessage, snapshot: RoomSnapshot): string | null {
  if (message.meta.kind === 'text') return `person:${message.authorId}`;
  if (message.meta.kind === 'session') {
    const meta = snapshot.sessionMetaByRun[message.meta.runId];
    return meta ? `agent:${meta.agent}:${meta.owner}` : null;
  }
  return null;
}

function isContinuation(prev: RoomMessage | undefined, message: RoomMessage, snapshot: RoomSnapshot): boolean {
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
  if ((snapshot.sessionEventsByRun[meta.id] ?? []).length > 0) return false;
  const running = (m: SessionRunMeta) =>
    effectiveRunStatus(m.status, projectSessionCard(snapshot.sessionEventsByRun[m.id] ?? [])) === 'running';
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

function renderItem(
  message: RoomMessage,
  snapshot: RoomSnapshot,
  ownId: string,
  onStopSession?: (runId: string) => Promise<boolean>,
  onResolvePermission?: (runId: string, requestId: string, optionId: string) => void,
  onOpenFile?: (relPath: string) => void,
  continued = false,
  onReply?: (ref: RoomReplyRef) => void,
  onJumpTo?: (messageId: string) => void,
  onRerun?: (agent: AgentKind, prompt: string) => void
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
      if (message.meta.event === 'joined') return <JoinRow message={message} snapshot={snapshot} />;
      // Day breaks are derived from timestamps (see RoomTranscript); a
      // scripted divider message would double them.
      if (message.meta.event === 'day_divider') return null;
      return <SystemRow message={message} snapshot={snapshot} />;
    case 'session': {
      const meta = snapshot.sessionMetaByRun[message.meta.runId];
      if (!meta) return null;
      const events = snapshot.sessionEventsByRun[message.meta.runId] ?? [];
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

/** Replies shown before "Show N earlier replies"; the thread's first comment always shows. */
const THREAD_VISIBLE_REPLIES = 3;

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
  const root = messages.find((m) => m.id === threadId);
  // When the agent's run is in the thread, that row is its reply: the
  // mirrored copy of the same answer would only repeat it.
  const hasRun = messages.some((m) => m.meta.kind === 'session');
  const rest = messages.filter(
    (m) => m !== root && !(hasRun && m.meta.kind === 'comment_mirror' && m.meta.replyFromAgent)
  );
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

const LAST_SEEN_PREFIX = 'rig-room-last-seen:';

function readLastSeen(key: string): number | null {
  try {
    const raw = localStorage.getItem(LAST_SEEN_PREFIX + key);
    const seq = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

function writeLastSeen(key: string, seq: number): void {
  try {
    localStorage.setItem(LAST_SEEN_PREFIX + key, String(seq));
  } catch {
    // Storage unavailable: no "New" line next time.
  }
}

/** The conversation's rows as outline entries: people's messages, agent turns, doc threads. */
function mapEntriesFor(units: TranscriptUnit[], snapshot: RoomSnapshot, ownId: string): MapEntry[] {
  const nameOf = (id: string) => snapshot.members.find((m) => m.id === id)?.name ?? id;
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
        preview: () => projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? []).finalAnswer || 'Working…',
      });
    }
  }
  return entries;
}

export function RoomTranscript({
  snapshot,
  ownId,
  onStopSession,
  onResolvePermission,
  onOpenFile,
  onReply,
  readKey,
  onRerun,
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
  /** Files a new turn for one of the viewer's own agents (Retry, Continue). */
  onRerun?: (agent: AgentKind, prompt: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Pinned = the reader is at the bottom, so new content keeps them there.
  // Scrolling up unpins; coming back near the bottom re-pins.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);

  const pinToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setPinned(true);
    setUnseen(0);
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const jumpTo = (messageId: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.animate([{ backgroundColor: 'var(--accent-subtle)' }, { backgroundColor: 'transparent' }], {
      duration: 1400,
      easing: 'ease-out',
    });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
      if (atBottom === pinnedRef.current) return;
      pinnedRef.current = atBottom;
      setPinned(atBottom);
      if (atBottom) setUnseen(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
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

  // New messages while scrolled up are counted for the jump-back pill; one
  // you sent yourself always brings you back down.
  const lastCountRef = useRef(snapshot.messages.length);
  useEffect(() => {
    const added = snapshot.messages.slice(lastCountRef.current);
    lastCountRef.current = snapshot.messages.length;
    if (added.length === 0) return;
    if (added.some((m) => m.authorId === ownId && m.meta.kind === 'text')) {
      pinToBottom();
      return;
    }
    if (!pinnedRef.current) setUnseen((n) => n + added.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.messages]);

  // Where you left off: the first message from someone else after the last
  // one you'd scrolled to, fixed for this visit (Slack's "New" line).
  const [newFromId, setNewFromId] = useState<string | null>(null);
  const markedRef = useRef(false);
  useEffect(() => {
    if (!readKey || markedRef.current || snapshot.messages.length === 0) return;
    markedRef.current = true;
    const lastRead = readLastSeen(readKey);
    if (lastRead === null) return;
    const first = snapshot.messages.find((m) => m.seq > lastRead && m.authorId !== ownId);
    if (first) setNewFromId(first.id);
  }, [readKey, snapshot.messages, ownId]);
  useEffect(() => {
    if (!readKey || !pinned || snapshot.messages.length === 0) return;
    writeLastSeen(readKey, Math.max(...snapshot.messages.map((m) => m.seq)));
  }, [readKey, pinned, snapshot.messages]);

  const mapEntries = useMemo(
    () => mapEntriesFor(groupThreads(snapshot.messages), snapshot, ownId),
    [snapshot, ownId]
  );

  const agentWorking = Object.values(snapshot.sessionMetaByRun).some(
    (meta) => meta.status === 'running' && snapshot.sessionEventsByRun[meta.id]?.every((e) => e.kind !== 'turn_ended')
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" data-testid="room-transcript">
      <div ref={contentRef} className="relative mx-auto flex max-w-[44rem] flex-col gap-4 px-3 pt-6 pb-3">
        <AnimatePresence initial={false}>
          {(() => {
            const units = groupThreads(snapshot.messages);
            const nodes: ReactNode[] = [];
            let lastDay = Number.NEGATIVE_INFINITY;
            let prevMessage: RoomMessage | undefined;
            for (const unit of units) {
              const unitIds = unit.kind === 'message' ? [unit.message.id] : unit.messages.map((m) => m.id);
              if (newFromId && unitIds.includes(newFromId)) {
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
                  <motion.div key={`day-${day}`}>
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
                  onRerun
                );
              const continuedUnit = unit.kind === 'message' && isContinuation(prevMessage, unit.message, snapshot);
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
              if (!node) continue;
              nodes.push(
                <motion.div
                  key={unit.kind === 'message' ? unit.message.id : `thread-${unit.threadId}`}
                  data-message-id={unit.kind === 'message' ? unit.message.id : unit.threadId}
                  // Room between speakers; a follow-up from the same one sits close.
                  className={cn('rounded-card', continuedUnit && '-mt-3')}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                >
                  {node}
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
    </div>
      <ConversationMap scrollRef={scrollRef} contentRef={contentRef} entries={mapEntries} onJump={jumpTo} />
      {!pinned && (unseen > 0 || agentWorking) && (
        <button
          type="button"
          onClick={() => pinToBottom('smooth')}
          className="card-pop-in border-border-hairline bg-bg-1 shadow-float hover:bg-bg-2 absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-2 rounded-chip border px-3 text-xs text-text-primary transition-colors"
          data-testid="jump-to-latest"
        >
          {agentWorking && <DotMatrix state="thinking" size="sm" />}
          {unseen > 0 ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : 'Jump to latest'}
          <ArrowDown className="size-3.5 text-text-muted" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
