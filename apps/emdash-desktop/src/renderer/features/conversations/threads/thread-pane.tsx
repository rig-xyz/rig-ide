/**
 * thread-pane.tsx — Slack-style thread pane in the task right sidebar.
 *
 * Opened via the transcript's thread button (threadUi.open + sidebar tab
 * 'thread'). Shows the anchor item, the reply history (you + agent), a live
 * region while a captured turn streams, and a composer where every Enter is
 * one reply sent to the agent with thread-scoped hidden context.
 *
 * Turn capture: after sending, we watch the session's activeTurn until a turn
 * appears whose user message text equals the sent reply (fallback: the first
 * turn that isn't the one active at send time), then record it as pendingTurn.
 * On commit (activeTurn → null) the assistant text of the captured turn is
 * appended to the thread; unless "Also send to channel" was checked, the turn
 * is hidden from the main transcript (collapsed to "discussed in thread").
 */

import type { TranscriptTurn } from '@emdash/core/acp/client';
import { X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationRegistry } from '@renderer/features/conversations/stores/conversation-registry';
import {
  useTaskViewContext,
  useWorkspaceViewModel,
} from '@renderer/features/tasks/task-view-context';
import type { SidebarTab } from '@renderer/features/tasks/types';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { AcpChatStore } from '../acp/acp-chat-store';
import { itemQuoteText } from './item-quote';
import { getThreadStore, threadUi, type OpenThread, type ThreadReply } from './thread-store';

/** Join a turn's assistant message texts (skips thinking/tool items). */
function assistantText(turn: TranscriptTurn): string {
  return turn.items
    .map((item) => (item.kind === 'message' && item.role === 'assistant' ? item.text : ''))
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}

export const ThreadPane = observer(function ThreadPane() {
  const { taskId } = useTaskViewContext();
  const taskView = useWorkspaceViewModel();
  const open = threadUi.openThread;

  const handleClose = useCallback(() => {
    const prev = threadUi.prevSidebarTab;
    threadUi.close();
    if (prev && prev !== 'thread') {
      taskView.setSidebarTab(prev as SidebarTab);
    } else {
      taskView.setSidebarCollapsed(true);
    }
  }, [taskView]);

  if (!open || open.taskId !== taskId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeader excerpt={null} onClose={handleClose} />
        <p className="px-3.5 py-3 text-sm text-foreground-muted">
          No thread open — hover a message and hit the thread button.
        </p>
      </div>
    );
  }

  return (
    <ThreadBody key={`${open.conversationId}:${open.itemId}`} open={open} onClose={handleClose} />
  );
});

function PaneHeader({ excerpt, onClose }: { excerpt: string | null; onClose: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3.5">
      <span className="shrink-0 text-sm text-foreground-muted">Thread</span>
      {excerpt !== null && (
        <span className="min-w-0 flex-1 truncate text-xs text-foreground-muted" title={excerpt}>
          {excerpt}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close thread"
        className="ml-auto shrink-0"
        onClick={onClose}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

const ThreadBody = observer(function ThreadBody({
  open,
  onClose,
}: {
  open: OpenThread;
  onClose: () => void;
}) {
  const store = open.store;
  const threadStore = getThreadStore(open.conversationId);
  const thread = threadStore.getThread(open.itemId);
  const replies = thread?.replies ?? [];

  const [draft, setDraft] = useState('');
  const [alsoToChannel, setAlsoToChannel] = useState(false);
  const repliesRef = useRef<HTMLDivElement | null>(null);
  const captureRef = useRef<{ unsub: () => void; timer: number } | null>(null);

  const providerId =
    conversationRegistry.get(open.taskId)?.conversations.get(open.conversationId)?.data
      .providerId ?? null;
  const { data: agents } = useAgents();
  const agentName = agents?.find((agent) => agent.id === providerId)?.name ?? 'Agent';

  const anchorText = itemQuoteText(
    store?.chatState.transcript.findItemById(open.itemId),
    open.excerpt
  );

  // ── Live region: the captured turn while it streams ─────────────────────────
  const pending = threadUi.pendingTurn;
  const pendingHere =
    pending !== null &&
    pending.conversationId === open.conversationId &&
    pending.itemId === open.itemId;
  const activeTurn = store?.session?.activeTurn.current() ?? null;
  const liveText =
    pendingHere && activeTurn !== null && activeTurn.id === pending.turnId
      ? assistantText(activeTurn)
      : null;

  // Keep the newest reply / streaming text visible.
  useEffect(() => {
    const el = repliesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length, liveText]);

  const cancelCapture = useCallback(() => {
    if (!captureRef.current) return;
    captureRef.current.unsub();
    window.clearTimeout(captureRef.current.timer);
    captureRef.current = null;
  }, []);
  useEffect(() => cancelCapture, [cancelCapture]);

  // ── Turn capture ────────────────────────────────────────────────────────────
  const captureTurn = useCallback(
    (chatStore: AcpChatStore, sentText: string, sendToChannel: boolean) => {
      const session = chatStore.session;
      if (!session) return;
      cancelCapture();
      // A turn already active at send time belongs to a previous prompt (the
      // reply is queued behind it); only later turns can be ours.
      const initialTurnId = session.activeTurn.current()?.id ?? null;
      let fallbackTurnId: string | null = null;
      const settle = (turnId: string) => {
        threadUi.setPending({
          conversationId: open.conversationId,
          itemId: open.itemId,
          turnId,
          alsoToChannel: sendToChannel,
        });
        cancelCapture();
      };
      const check = (): boolean => {
        const current = session.activeTurn.current();
        if (!current || current.id === initialTurnId) return false;
        const matches = current.items.some(
          (item) => item.kind === 'message' && item.role === 'user' && item.text === sentText
        );
        if (matches) {
          settle(current.id);
          return true;
        }
        fallbackTurnId ??= current.id;
        return false;
      };
      if (check()) return;
      const unsub = session.activeTurn.onChange(() => {
        check();
      });
      const timer = window.setTimeout(() => {
        cancelCapture();
        if (fallbackTurnId !== null) settle(fallbackTurnId);
      }, 10_000);
      captureRef.current = { unsub, timer };
    },
    [cancelCapture, open.conversationId, open.itemId]
  );

  // ── Commit: fold the captured turn's reply back into the thread ─────────────
  useEffect(() => {
    const session = store?.session;
    if (!store || !session) return;
    let lastTurn = session.activeTurn.current();
    return session.activeTurn.onChange(() => {
      const current = session.activeTurn.current();
      const pendingTurn = threadUi.pendingTurn;
      if (
        lastTurn !== null &&
        current === null &&
        pendingTurn !== null &&
        pendingTurn.conversationId === store.conversationId
      ) {
        // Prefer the final streamed snapshot (committedTurns re-seeds async).
        const committed =
          lastTurn.id === pendingTurn.turnId
            ? lastTurn
            : store.chatState.transcript.state.committedTurns.find(
                (turn) => turn.id === pendingTurn.turnId
              );
        if (committed) {
          const text = assistantText(committed);
          const conversationThreads = getThreadStore(store.conversationId);
          if (text) conversationThreads.addReply(pendingTurn.itemId, 'agent', text);
          if (!pendingTurn.alsoToChannel) {
            conversationThreads.hideTurn(pendingTurn.turnId, pendingTurn.itemId);
            store.refreshHistory();
          }
        }
        threadUi.clearPending();
      }
      lastTurn = current;
    });
  }, [store, store?.session]);

  // ── Send flow: every Enter is one reply ─────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || !store) return;
    setDraft('');
    threadStore.addReply(open.itemId, 'you', text);
    const quoted = itemQuoteText(
      store.chatState.transcript.findItemById(open.itemId),
      open.excerpt
    );
    const hiddenContext = `Thread reply anchored to your earlier output (item ${open.itemId}). Quoted content: """${quoted}""". Reply concisely IN THE CONTEXT of this thread.`;
    if (store.affordances.isWorking) {
      store.queuePrompt(text, [], hiddenContext);
    } else {
      store.submitPrompt(text, [], hiddenContext);
    }
    captureTurn(store, text, alsoToChannel);
  }, [draft, store, threadStore, open.itemId, open.excerpt, captureTurn, alsoToChannel]);

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader excerpt={open.excerpt} onClose={onClose} />

      <div ref={repliesRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <div className="border-l-2 border-border-1 pl-2.5">
          <MarkdownRenderer content={anchorText} variant="compact" className="text-sm" />
        </div>

        <div className="mt-3 flex flex-col gap-3">
          {replies.map((reply, index) => (
            <ReplyRow key={`${reply.at}:${index}`} reply={reply} agentName={agentName} />
          ))}
          {liveText !== null && (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-foreground">{agentName}</span>
                <span className="animate-pulse text-[10px] text-foreground-muted">typing…</span>
              </div>
              {liveText.length > 0 && (
                <MarkdownRenderer content={liveText} variant="compact" className="text-sm" />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-3.5 py-2.5">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder="Reply…"
          className="max-h-40 min-h-9"
          rows={1}
          disabled={!store}
        />
        <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-foreground-muted">
          <Checkbox
            checked={alsoToChannel}
            onCheckedChange={(checked) => setAlsoToChannel(checked === true)}
          />
          Also send to channel
        </label>
      </div>
    </div>
  );
});

function ReplyRow({ reply, agentName }: { reply: ThreadReply; agentName: string }) {
  if (reply.author === 'you') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground">You</span>
          <RelativeTime
            value={reply.at}
            compact
            ago
            className="text-[10px] text-foreground-muted"
          />
        </div>
        <div className="max-w-full rounded-md bg-background-secondary-1 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-foreground">
          {reply.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-foreground">{agentName}</span>
        <RelativeTime value={reply.at} compact ago className="text-[10px] text-foreground-muted" />
      </div>
      <MarkdownRenderer
        content={reply.text}
        variant="compact"
        className="text-sm"
        externalImages="click"
      />
    </div>
  );
}
