import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { RoomMessage, RoomSnapshot } from '../types';
import { SessionCard } from './session-card';
import {
  CommentMirrorLine,
  DayDivider,
  InviteRow,
  JoinRow,
  MessageBubble,
  SystemRow,
  TypingBubble,
} from './transcript-items';

/**
 * Spaces (lane 2): the Room transcript — a keyed list where new items
 * animate in (`AnimatePresence` + `motion.div`'s enter transition) and
 * every row carries `layout` so a growing session card (new steps, new
 * output rows landing) animates its own height change instead of snapping.
 * Follow-scroll stays pinned to the bottom while new items arrive, and
 * stops the moment the user scrolls up by hand — resuming automatically
 * once they scroll back within a small threshold of the bottom, same
 * heuristic as the reference demo.
 */

const FOLLOW_THRESHOLD_PX = 60;

function renderItem(
  message: RoomMessage,
  snapshot: RoomSnapshot,
  ownId: string,
  onStopSession?: (runId: string) => void,
  onResolvePermission?: (runId: string, requestId: string, optionId: string) => void,
  onOpenFile?: (relPath: string) => void
) {
  switch (message.meta.kind) {
    case 'text':
      return <MessageBubble message={message} snapshot={snapshot} ownId={ownId} />;
    case 'invite':
      return <InviteRow message={message} snapshot={snapshot} />;
    case 'comment_mirror':
      return <CommentMirrorLine message={message} snapshot={snapshot} onOpenFile={onOpenFile} />;
    case 'system':
      if (message.meta.event === 'joined') return <JoinRow message={message} snapshot={snapshot} />;
      if (message.meta.event === 'day_divider') return <DayDivider message={message} />;
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
  const rest = messages.filter((m) => m !== root);
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
          className="ml-[22px] self-start text-xs text-text-muted transition-colors hover:text-text-primary"
          data-testid="thread-show-earlier"
        >
          Show {hidden} earlier {hidden === 1 ? 'reply' : 'replies'}
        </button>
      )}
      {shown.length > 0 && (
        <div className="border-border-hairline ml-[7px] flex flex-col gap-2.5 border-l pl-[15px]">
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

export function RoomTranscript({
  snapshot,
  ownId,
  onStopSession,
  onResolvePermission,
  onOpenFile,
}: {
  snapshot: RoomSnapshot;
  ownId: string;
  onStopSession?: (runId: string) => void;
  onResolvePermission?: (runId: string, requestId: string, optionId: string) => void;
  /** Opens a space file (relative path) in the editor, e.g. from a doc comment line. */
  onOpenFile?: (relPath: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = () => {
      followRef.current = false;
      const check = () => {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < FOLLOW_THRESHOLD_PX) followRef.current = true;
      };
      window.setTimeout(check, 600);
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const itemCount = snapshot.messages.length + snapshot.typingUserIds.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
    // Only the item count needs to trigger a re-scroll — a session card
    // growing in place (more steps/outputs) is already visible without
    // moving the viewport, and re-running this on every snapshot change
    // would fight the user's own scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="room-transcript">
      <div className="mx-auto flex max-w-[44rem] flex-col gap-3 px-5 pt-6 pb-3">
        <AnimatePresence initial={false}>
          {groupThreads(snapshot.messages).map((unit) => {
            const render = (message: RoomMessage) =>
              renderItem(message, snapshot, ownId, onStopSession, onResolvePermission, onOpenFile);
            const node =
              unit.kind === 'message' ? (
                render(unit.message)
              ) : (
                <ThreadBlock
                  threadId={unit.threadId}
                  messages={unit.messages}
                  renderMessage={render}
                  renderReply={(message) => (
                    <CommentMirrorLine message={message} snapshot={snapshot} onOpenFile={onOpenFile} inThread />
                  )}
                />
              );
            if (!node) return null;
            return (
              <motion.div
                key={unit.kind === 'message' ? unit.message.id : `thread-${unit.threadId}`}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {node}
              </motion.div>
            );
          })}
          {snapshot.typingUserIds.map((personId) => (
            <motion.div
              key={`typing-${personId}`}
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <TypingBubble personId={personId} snapshot={snapshot} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
