import { viewMetasWrittenBy, viewScheduleSignature } from '@shared/rig/views';
import type { RawSessionEvent } from '../spaces/dispatch';

/**
 * A schedule is agreed to when this Mac's own session wrote it (`view-refresh.ts`). A Room run
 * reports its writes as it goes (`dispatch-controller-instance.ts`'s `recordLocal`). The person's
 * other sessions in a space are chats the window owns (one Home's chat started for them, a side
 * chat, one of "Your sessions"): they never pass that way, so a schedule one of them wrote used to
 * wait for an "Accept" as if another member had set it. This follows those sessions from main and
 * reports the `view.json` files they write, the same way.
 *
 * Only a session whose folder is a space on this Mac is followed, and only the diffs its own file
 * tools report count: a schedule that arrives by sync is still asked about.
 */
export type OwnChatWritesDeps = {
  /** The space a session's folder is (or is inside); null when it is not a space on this Mac. */
  bindingOf: (cwd: string) => string | null;
  /** The session's raw updates; rejects while the session is not there yet. */
  subscribeRaw: (conversationId: string, on: (event: RawSessionEvent) => void) => Promise<() => void>;
  mark: (bindingId: string, view: string, signature: string | null) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How often to try for a session that has not started yet. */
  retries?: number;
  retryMs?: number;
};

export function createOwnChatWrites(deps: OwnChatWritesDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = deps.retries ?? 20;
  const retryMs = deps.retryMs ?? 500;
  // By conversation: the way to stop following it, or 'starting' until the session is there.
  const followed = new Map<string, (() => void) | 'starting'>();

  async function follow(conversationId: string, bindingId: string): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      if (followed.get(conversationId) !== 'starting') return; // ended, or started again, meanwhile
      try {
        const stop = await deps.subscribeRaw(conversationId, (event) => {
          if (event.kind !== 'acp_update') return;
          const kind = event.update.sessionUpdate;
          if (kind !== 'tool_call' && kind !== 'tool_call_update') return;
          for (const { view, schedule } of viewMetasWrittenBy(event.update)) {
            deps.mark(bindingId, view, schedule ? viewScheduleSignature(schedule) : null);
          }
        });
        if (followed.get(conversationId) === 'starting') followed.set(conversationId, stop);
        else stop();
        return;
      } catch {
        await sleep(retryMs);
      }
    }
    if (followed.get(conversationId) === 'starting') followed.delete(conversationId);
  }

  return {
    /** A session is starting (or resuming). Room runs (`projectId: 'space'`) report their own writes. */
    started(input: { conversationId: string; cwd?: string | null; projectId?: string | null }): void {
      if (input.projectId === 'space' || !input.cwd) return;
      const bindingId = deps.bindingOf(input.cwd);
      if (!bindingId) return;
      const before = followed.get(input.conversationId);
      if (before === 'starting') return;
      if (typeof before === 'function') before();
      followed.set(input.conversationId, 'starting');
      void follow(input.conversationId, bindingId);
    },
    ended(conversationId: string): void {
      const stop = followed.get(conversationId);
      followed.delete(conversationId);
      if (typeof stop === 'function') stop();
    },
  };
}
