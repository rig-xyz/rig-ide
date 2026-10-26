import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import { getSessionAttentionFacts } from '@renderer/features/chat/session-attention-store';
import type { RigStoredSession } from '@shared/rig/sessions';

/**
 * Your own sessions in a space, as the dock shows them (`my-sessions.ts`
 * reads them; `dock-pills.tsx` draws them). Pure, so the states are testable.
 */

export type MySessionState = 'waiting' | 'working' | 'done' | 'idle';

export type MyApproval = {
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  resolvingOptionId: string | null;
};

export type MySession = {
  id: string;
  title: string;
  state: MySessionState;
  /** What it waits on you for, while `state` is 'waiting'. */
  approval: MyApproval | null;
  /** When it started in this window (working), else when it was last touched. */
  at: number;
};

export type MySessions = {
  /** The ones the dock shows: waiting, working, or done and not yet seen; oldest first. */
  rows: MySession[];
  /** Every session of the space, newest first: the Sessions list. */
  all: MySession[];
  resolve: (sessionId: string, optionId: string) => void;
};

/** One stored session's state, from its live store when there is one. Reads MobX state. */
export function mySessionOf(stored: RigStoredSession, live: RigChatStore | null): MySession {
  const title = live?.title?.trim() || stored.title?.trim() || 'Untitled session';
  if (!live) return { id: stored.id, title, state: 'idle', approval: null, at: stored.updatedAt };
  const request = live.permissionQueue[0];
  if (request) {
    return {
      id: stored.id,
      title,
      state: 'waiting',
      approval: {
        title: request.title,
        options: request.options,
        resolvingOptionId: live.resolvingPermissionOptionId,
      },
      at: live.createdAt,
    };
  }
  if (live.affordances.isWorking) {
    return { id: stored.id, title, state: 'working', approval: null, at: live.createdAt };
  }
  const facts = getSessionAttentionFacts(stored.id);
  const unseen = facts.lastOutputAt !== null && facts.lastOutputAt > (facts.lastSeenAt ?? 0);
  return {
    id: stored.id,
    title,
    state: unseen ? 'done' : 'idle',
    approval: null,
    at: unseen ? live.createdAt : stored.updatedAt,
  };
}
