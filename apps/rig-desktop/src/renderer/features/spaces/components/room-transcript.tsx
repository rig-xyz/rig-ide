import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
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
          {snapshot.messages.map((message) => {
            const node = renderItem(message, snapshot, ownId, onStopSession, onResolvePermission, onOpenFile);
            if (!node) return null;
            return (
              <motion.div
                key={message.id}
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
