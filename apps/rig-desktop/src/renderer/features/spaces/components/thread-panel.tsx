import { ChevronLeft, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { runCard } from '../projection';
import type { ThreadFace, ThreadSummary } from '../threads';
import { personOf, resolvePerson } from '../person-identity';
import type { RoomMember, RoomMessage, RoomReplyRef, RoomSnapshot } from '../types';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';
import { excerptOf } from './transcript-items';

/**
 * Threads view (Settings › Spaces › Chat view): the reply row under a root
 * in the main column, and the panel a thread opens in. A thread is a message
 * plus every reply to it (`threads.ts`).
 */

/** Panel width beside the chat. */
export const THREAD_PANEL_PX = 440;

const plural = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`;

function Face({ face, members }: { face: ThreadFace; members: readonly RoomMember[] }) {
  if (face.kind === 'agent') {
    return (
      <AgentAvatar
        agent={face.agent}
        owner={members.find((m) => m.id === face.owner)}
        size="sm"
        className="ring-bg-0 ring-2"
      />
    );
  }
  const person = resolvePerson(face.id, { members });
  return (
    <PersonAvatar
      member={person.member}
      person={person}
      size="sm"
      className="ring-bg-0 rounded-full ring-2"
    />
  );
}

/**
 * Under a root with replies: who replied, how many, and when the last one
 * came, or the agent at work in it. Unread replies light the count. Opens
 * the thread.
 */
export function ThreadReplyRow({
  summary,
  members,
  mine,
  open,
  onOpen,
}: {
  summary: ThreadSummary;
  members: readonly RoomMember[];
  /** Under your own message, which sits on the right. */
  mine: boolean;
  /** This thread is the one open. */
  open: boolean;
  onOpen: () => void;
}) {
  const unread = summary.unread > 0;
  return (
    <div className={cn('flex pt-1', mine ? 'justify-end pr-2' : 'pl-12')}>
      <button
        type="button"
        onClick={onOpen}
        data-open={open ? 'true' : undefined}
        data-unread={unread ? 'true' : undefined}
        data-testid="thread-reply-row"
        className={cn(
          'glass-hover flex h-7 max-w-full min-w-0 items-center gap-2 rounded-chip px-1.5 pr-2.5 text-xs',
          open && 'glass-selected'
        )}
      >
        <span className="flex shrink-0 -space-x-1.5">
          {summary.faces.map((face) => (
            <Face key={face.kind === 'agent' ? `a:${face.agent}:${face.owner}` : `p:${face.id}`} face={face} members={members} />
          ))}
        </span>
        <span
          className={cn('shrink-0', unread ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary')}
          data-testid="thread-reply-count"
        >
          {plural(summary.count)}
        </span>
        {summary.working ? (
          <span className="flex min-w-0 items-center gap-1.5 text-text-secondary" data-testid="thread-working">
            <DotMatrix state="thinking" size="sm" />
            <span className="truncate">{AGENT_NAME[summary.working]} is working</span>
          </span>
        ) : (
          <span className="shrink-0 text-text-muted">last {summary.last.time}</span>
        )}
      </button>
    </div>
  );
}

/** What a reply in a thread points at, as Reply on that row would: who it's from and a short excerpt. */
export function replyRefFor(
  message: RoomMessage,
  snapshot: Pick<RoomSnapshot, 'members' | 'messages' | 'sessionMetaByRun' | 'sessionEventsByRun' | 'sessionSummaryByRun'>,
  ownId: string
): RoomReplyRef {
  const nameOf = (id: string) => personOf(snapshot, id).name;
  if (message.meta.kind === 'session') {
    const run = snapshot.sessionMetaByRun[message.meta.runId];
    if (run) {
      const agent = AGENT_NAME[run.agent];
      return {
        id: message.id,
        authorId: run.owner,
        label: run.owner === ownId ? `Your ${agent}` : `${nameOf(run.owner)}'s ${agent}`,
        excerpt: excerptOf(runCard(snapshot, run.id).finalAnswer || message.body || ''),
      };
    }
  }
  return { id: message.id, authorId: message.authorId, label: nameOf(message.authorId), excerpt: excerptOf(message.body ?? '') };
}

/** Rings a row the way the main column's jump does. */
function highlight(target: HTMLElement): void {
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const ring = target.querySelector<HTMLElement>('[data-highlight-target]') ?? target;
  ring.animate?.(
    [
      { boxShadow: '0 0 0 2px var(--accent), 0 0 0 6px var(--accent-subtle)' },
      { boxShadow: '0 0 0 2px transparent, 0 0 0 6px transparent' },
    ],
    { duration: 1600, easing: 'ease-out' }
  );
}

const FOLLOW_THRESHOLD_PX = 60;

/**
 * One thread: its root, a hairline "N replies" divider, the replies in
 * order, and its own composer. Beside the chat it's a ~440px column with a
 * ×; in a split view (a doc open beside the chat) or a narrow Room it takes
 * the chat column's place, with "‹ #space" to go back. Esc closes it too.
 */
export function ThreadPanel({
  root,
  replies,
  spaceName,
  mode,
  onClose,
  focus,
  renderMessage,
  isContinuation,
  composer,
}: {
  root: RoomMessage;
  replies: readonly RoomMessage[];
  spaceName: string;
  mode: 'beside' | 'replace';
  onClose: () => void;
  /** Scroll to this reply and ring it (a notification's jump), once per nonce. */
  focus: { messageId: string; nonce: number } | null;
  /** Draws one message as the main column does; `onJumpTo` scrolls within the thread. */
  renderMessage: (message: RoomMessage, continued: boolean, onJumpTo: (messageId: string) => void) => ReactNode;
  isContinuation: (prev: RoomMessage | undefined, message: RoomMessage) => boolean;
  composer: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Esc closes the thread, unless something inside handled it (the composer
  // dropping a reply, a menu closing). On the document, so it runs before the
  // dock's own Esc on the window and that one sees it handled.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Opens at the newest reply, and follows new ones (and an answer streaming
  // in) while you're there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [replies]);
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const jumpTo = (messageId: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    pinnedRef.current = false;
    highlight(target);
  };
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;
  const focusNonce = focus?.nonce ?? null;
  const focusId = focus?.messageId ?? null;
  useEffect(() => {
    if (focusNonce === null || !focusId) return;
    requestAnimationFrame(() => jumpToRef.current(focusId));
  }, [focusNonce, focusId]);

  // In the thread, a reply to its root needs no quote line: it's right above.
  const shown = (message: RoomMessage): RoomMessage =>
    message.meta.kind === 'text' && message.meta.replyTo?.id === root.id
      ? { ...message, meta: { ...message.meta, replyTo: undefined } }
      : message;

  return (
    <aside
      className={cn(
        'bg-bg-0 relative z-30 flex h-full min-h-0 flex-col',
        mode === 'beside' ? 'border-border-hairline shrink-0 border-l' : 'min-w-0 flex-1'
      )}
      style={mode === 'beside' ? { width: THREAD_PANEL_PX } : undefined}
      aria-label="Thread"
      data-testid="thread-panel"
      data-mode={mode}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        {mode === 'replace' ? (
          <button
            type="button"
            onClick={onClose}
            className="hover:bg-bg-2 -ml-1 flex h-7 items-center gap-1 rounded-control pr-2 pl-1 text-sm text-text-primary transition-colors"
            data-testid="thread-back"
          >
            <ChevronLeft className="size-4 text-text-muted" strokeWidth={1.5} />
            {spaceName}
          </button>
        ) : (
          <>
            <b className="text-sm font-medium text-text-primary">Thread</b>
            <span className="min-w-0 truncate text-xs text-text-muted">{spaceName}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close thread"
              title="Close thread"
              className="hover:bg-bg-2 ml-auto flex size-7 items-center justify-center rounded-control text-text-muted transition-colors"
              data-testid="thread-close"
            >
              <X className="size-4" strokeWidth={1.5} />
            </button>
          </>
        )}
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" data-testid="thread-scroll">
        <div ref={contentRef} className="flex flex-col gap-3 px-3 pt-2 pb-6">
          <div data-message-id={root.id} className="rounded-card">
            {renderMessage(root, false, jumpTo)}
          </div>
          {replies.length > 0 && (
            <div className="flex items-center gap-3 px-2" data-testid="thread-divider">
              <span className="text-2xs text-text-muted">{plural(replies.length)}</span>
              <span className="bg-border-hairline h-px flex-1" />
            </div>
          )}
          {replies.map((message, i) => {
            const continued = isContinuation(replies[i - 1], message);
            return (
              <div
                key={message.clientId ?? message.id}
                data-message-id={message.id}
                className={cn('rounded-card', continued && '-mt-2')}
              >
                {renderMessage(shown(message), continued, jumpTo)}
              </div>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 px-3 pb-4">{composer}</div>
    </aside>
  );
}
