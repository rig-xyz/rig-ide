import { useEffect } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { rigStartSessionChannel, type RigSessionStart } from '@shared/rig/feed';
import { canResumeSession } from '../resume-capability';
import { RigChatStore } from '../rig-chat-store';
import { rigSessionRegistry } from './rig-session-registry';

/**
 * Rig starting work for the person in a space: a Feed card's Start, or Home
 * chat's rig_start. Main writes the brief and links the session to its
 * situation (orch/actions.ts); the session itself is one of the space's own
 * chats, created here because chat sessions live in the window
 * (rig-session-registry.ts). It runs without its space on screen, saves
 * itself like any chat, and shows under the space's Sessions.
 *
 * A follow-up continues the situation's earlier session: the live one if it
 * is still running here, else resumed from its saved row, else (a session
 * that can't be resumed) a new one in its place.
 */
export async function startInSpace(start: RigSessionStart): Promise<void> {
  if (start.continue) {
    const live = rigSessionRegistry.get(start.sessionId);
    if (live instanceof RigChatStore && !live.disposed) {
      if (start.askFirst && !live.startInMode(ASK_FIRST)) return couldNotAskFirst(start);
      live.submitPrompt(start.prompt);
      return;
    }
    const stored = await rpc.rig.sessions.getSession({ sessionId: start.sessionId });
    if (stored && canResumeSession(stored.providerId, stored.acpSessionId)) {
      // A read-only replay of it may be open: the live one takes its place.
      await rigSessionRegistry.stop(stored.id);
      const resumed = rigSessionRegistry.attach<RigChatStore>(
        stored.id,
        () =>
          new RigChatStore(stored.id, start.bindingId, start.root, stored.providerId, {
            acpSessionId: stored.acpSessionId!,
            title: stored.title,
            titleSource: stored.titleSource,
          })
      );
      await run(resumed, start, false);
      return;
    }
  }
  const id = start.continue ? crypto.randomUUID() : start.sessionId;
  const fresh = rigSessionRegistry.attach<RigChatStore>(
    id,
    () => new RigChatStore(id, start.bindingId, start.root, 'claude')
  );
  // A follow-up that couldn't continue its session: the new one is the situation's now.
  if (id !== start.sessionId && start.situationId)
    void rpc.rig.orch.linkSession({ sessionId: id, situationId: start.situationId, bindingId: start.bindingId });
  await run(fresh, start, true);
}

/** Claude Code's "Ask first": every tool call that writes or runs asks you. */
const ASK_FIRST = 'default';

/** A Reply that can't ask first doesn't run: better nothing than a draft that sends itself. */
function couldNotAskFirst(start: RigSessionStart): void {
  toast({ title: `Couldn't start "${start.title}" in Ask first, so it didn't run` });
}

async function run(store: RigChatStore, start: RigSessionStart, named: boolean): Promise<void> {
  await store.bootstrap();
  if (store.loadError) {
    toast({ title: `Couldn't start "${start.title}"` });
    return;
  }
  // The space's own mode, as any chat started there would get (a resumed one keeps its own);
  // a card's Reply asks first, before anything it does.
  if (start.askFirst && !store.startInMode(ASK_FIRST)) return couldNotAskFirst(start);
  store.submitPrompt(start.prompt);
  // Named after the card, not after "Work through sessions/…/brief.md"; after
  // the prompt, so the name lands once the prompt has created the session's row.
  if (named) store.rename(start.title);
}

/** Mounted once for the app: starts what main asks for, wherever the person is. */
export function useRigSessionStarts(): void {
  useEffect(() => events.on(rigStartSessionChannel, (start) => void startInSpace(start)), []);
}
