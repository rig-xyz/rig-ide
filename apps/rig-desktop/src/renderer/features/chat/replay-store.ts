import { createChatState, type ChatContext, type ChatState } from '@emdash/chat-ui';
import { action, makeObservable, observable, runInAction } from 'mobx';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { rpc } from '@renderer/lib/ipc';
import type { RigStoredSession } from '@shared/rig/sessions';
import { parseStoredEvents, withTurnTimestamps } from './session-writer';

/**
 * A read-only view of a past `rig_sessions` row (`persistence-design.md`
 * Round B) — the History list's "open a stored session" seam.
 *
 * No `AcpLiveSession`, no wire connection, no `bootstrap()`: the runtime
 * seam this needs already exists in `chat-ui` — `chatState.transcript
 * .history.seed(turns)` renders a static `TranscriptTurn[]` on its own,
 * commented as "prefer for initial load / session replay" — so this is
 * exactly `RigChatStore`'s bootstrap minus everything live. `chat-panel.tsx`
 * feeds the same `chatContext`/`chatState` pair to the same
 * `<ChatTranscript>` either way; only the composer area differs (a
 * "Session from …" bar with Resume/Start-follow-up instead of a text field).
 */
export class ReplayStore {
  readonly kind = 'replay' as const;
  readonly chatContext: ChatContext;
  readonly chatState: ChatState;

  loading = true;
  /** Null once `session` loads; a plain message on failure (deleted row, read error). */
  error: string | null = null;
  session: RigStoredSession | null = null;

  constructor(readonly conversationId: string) {
    this.chatContext = getSharedChatContext();
    this.chatState = createChatState(this.chatContext, { uri: conversationId });

    makeObservable(this, {
      loading: observable,
      error: observable,
      session: observable.ref,
      load: action,
      rename: action,
    });
  }

  async load(): Promise<void> {
    try {
      const [session, events] = await Promise.all([
        rpc.rig.sessions.getSession({ sessionId: this.conversationId }),
        rpc.rig.sessions.getEvents({ sessionId: this.conversationId }),
      ]);
      if (!session) throw new Error('This session is no longer stored.');
      const { turns, atBySeq } = parseStoredEvents(events);

      runInAction(() => {
        this.session = session;
        this.chatState.transcript.history.seed(withTurnTimestamps(turns, atBySeq));
        this.loading = false;
      });
    } catch (error) {
      console.error('Rig chat: failed to load a stored session for replay', {
        sessionId: this.conversationId,
        error,
      });
      runInAction(() => {
        this.loading = false;
        this.error = error instanceof Error ? error.message : 'Could not load this session.';
      });
    }
  }

  /**
   * Explicit user rename (round S2+) — a read-only replay tab has no
   * `RigChatStore`/auto-titling behind it, so this is just the write plus a
   * local echo (`session` is `observable.ref`, so a plain replace is enough
   * to re-render the tab label) — no `title`/`titleSource` fields of its
   * own the way `RigChatStore` has, since `session` already carries both.
   */
  rename(title: string): void {
    const trimmed = title.trim();
    if (!trimmed || !this.session) return;
    this.session = { ...this.session, title: trimmed, titleSource: 'manual' };
    void rpc.rig.sessions.rename({ sessionId: this.conversationId, title: trimmed }).catch((error: unknown) => {
      console.error('Rig chat: failed to rename a stored session', {
        sessionId: this.conversationId,
        error,
      });
    });
  }

  dispose(): void {
    this.chatState.dispose();
  }
}
