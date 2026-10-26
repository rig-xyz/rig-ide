import { useQuery, useQueryClient } from '@tanstack/react-query';
import { autorun } from 'mobx';
import { useEffect, useState } from 'react';
import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import { subscribeSessionAttention } from '@renderer/features/chat/session-attention-store';
import { rigSessionRegistry } from '@renderer/features/chat/session/rig-session-registry';
import { events, rpc } from '@renderer/lib/ipc';
import { rigStartSessionChannel } from '@shared/rig/feed';
import type { RigStoredSession } from '@shared/rig/sessions';
import { mySessionOf, type MySession, type MySessions, type MySessionState } from './my-sessions-model';

/**
 * Your own sessions in a space: the chats Rig started for you (a Feed
 * card's Start) or you opened yourself, which are not Room messages and so
 * never get a Room topic. The dock hangs the ones that need a look under
 * "Just you" (`dock-pills.tsx`); its Sessions pill lists them all.
 *
 * A session's state comes from its live store when it runs in this window:
 * waiting on an approval, working, or done with output you haven't seen
 * (`session-attention-store.ts`). Anything else is idle: in the list only.
 */

function liveStore(sessionId: string): RigChatStore | null {
  const held = rigSessionRegistry.get<RigChatStore>(sessionId);
  return held && (held as { kind?: unknown }).kind === 'live' && !held.disposed ? held : null;
}

/** The chat panel's History list reads the same rows. */
function historyKey(bindingId: string | undefined) {
  return ['rig', 'sessions', 'history', bindingId ?? ''];
}

const SHOWN: ReadonlySet<MySessionState> = new Set(['waiting', 'working', 'done']);

export function useMySessions(bindingId: string | undefined): MySessions {
  const queryClient = useQueryClient();
  const { data: stored } = useQuery<RigStoredSession[]>({
    queryKey: historyKey(bindingId),
    queryFn: () => rpc.rig.sessions.listSessions({ bindingId: bindingId!, limit: 30 }),
    enabled: !!bindingId,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
  // A start lands here a moment later: its row is written once its store bootstraps.
  useEffect(() => {
    if (!bindingId) return;
    return events.on(rigStartSessionChannel, (start) => {
      if (start.bindingId !== bindingId) return;
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: historyKey(bindingId) }), 1_500);
    });
  }, [bindingId, queryClient]);

  // Seen and unseen output is not MobX state: its own store says when it moves.
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    const offs = (stored ?? []).map((s) => subscribeSessionAttention(s.id, () => setAttention((n) => n + 1)));
    return () => {
      for (const off of offs) off();
    };
  }, [stored]);
  const [all, setAll] = useState<MySession[]>([]);
  useEffect(() => {
    const list = stored ?? [];
    return autorun(() => setAll(list.map((s) => mySessionOf(s, liveStore(s.id)))));
  }, [stored, attention]);

  const rows = all.filter((s) => SHOWN.has(s.state)).sort((a, b) => a.at - b.at);
  const resolve = (sessionId: string, optionId: string) => liveStore(sessionId)?.resolvePermission(optionId);
  return { rows, all, resolve };
}
