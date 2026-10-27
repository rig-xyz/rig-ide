import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { autorun } from 'mobx';
import { useEffect, useMemo, useState } from 'react';
import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import { rigSessionRegistry } from '@renderer/features/chat/session/rig-session-registry';
import { useSpaceStatus } from '@renderer/features/home/use-space-status';
import { useNotificationSummary } from '@renderer/features/notifications/use-notifications';
import { useMySpaces } from '@renderer/features/people/use-people';
import { events, rpc } from '@renderer/lib/ipc';
import { rigStartSessionChannel } from '@shared/rig/feed';
import type { RailSpace } from './model';
import { orderSpacesByActivity, realSpaceToRail } from './rail-data';

/**
 * The user's real spaces as rail entries: the account's space bindings, their
 * live runs (`rpc.rig.spaceStatus`), unread counts (notifications summary),
 * members (lock or faces), their recent local chats, and where each lives on
 * disk so it can be opened. Shares every query key the current Home uses, so
 * switching between the two Homes reads the same caches.
 */
export function useRealSpaces(): {
  spaces: RailSpace[];
  selfName: string | null;
  selfAvatarUrl: string | null;
} {
  const bindings = useMySpaces();
  const ids = useMemo(() => (bindings ?? []).map((b) => b.id), [bindings]);

  const me = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const self = me.data?.success ? me.data.data : null;

  const status = useSpaceStatus(ids.length > 0);
  const summary = useNotificationSummary();

  const local = useQuery({
    queryKey: ['rig', 'recent', 'list'],
    queryFn: () => rpc.rig.recent.recentRigs(50),
    staleTime: 5_000,
  });
  const localById = useMemo(
    () => new Map((local.data ?? []).map((r) => [r.bindingId, r.path])),
    [local.data]
  );
  const missing = useMemo(() => ids.filter((id) => !localById.has(id)), [ids, localById]);
  const resolved = useQuery({
    queryKey: ['rig', 'recent', 'resolveLocalPaths', missing],
    queryFn: () => rpc.rig.recent.resolveLocalPaths({ bindingIds: missing }),
    enabled: missing.length > 0,
  });

  const chats = useQuery({
    queryKey: RECENT_CHATS_KEY,
    queryFn: () => rpc.rig.sessions.listRecentAcrossRigs({ limit: 30 }),
    staleTime: 5_000,
  });
  useRefreshChatsOnStart();
  const live = useLiveChats(chats.data);

  const members = useQueries({
    queries: ids.map((bindingId) => ({
      queryKey: ['rig', 'spacesConnection', 'listMembers', bindingId],
      queryFn: () => rpc.rig.spacesConnection.listMembers({ bindingId }),
      staleTime: 60_000,
    })),
  });
  const membersKey = members.map((m) => m.dataUpdatedAt).join(',');

  const spaces = useMemo(() => {
    const now = Date.now();
    const statusList = status.data?.success ? status.data.data : [];
    const statusBy = new Map(statusList.map((s) => [s.bindingId, s]));
    const unreadBy = new Map(summary.spaces.map((s) => [s.bindingId, s.spaceUnread]));
    return orderSpacesByActivity(
      (bindings ?? []).map((binding, i) => {
        const listed = members[i]?.data;
        const space = realSpaceToRail(
            {
              bindingId: binding.id,
              name: binding.name,
              path: localById.get(binding.id) ?? resolved.data?.[binding.id] ?? null,
              members: listed?.success ? listed.data : null,
              unread: unreadBy.get(binding.id) ?? 0,
              status: statusBy.get(binding.id),
              chats: (chats.data ?? [])
                .filter((c) => c.rigBindingId === binding.id)
                .map((c) => (live.has(c.id) ? { ...c, live: live.get(c.id) } : c)),
            },
            self?.id ?? null,
            now
          );
        return { space, madeAt: Date.parse(binding.updatedAt ?? binding.createdAt) || 0 };
      })
    );
    // `members` is a fresh array every render; `membersKey` says when any of it changed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bindings,
    status.data,
    summary.spaces,
    localById,
    resolved.data,
    chats.data,
    live,
    membersKey,
    self?.id,
  ]);

  return { spaces, selfName: self?.name ?? null, selfAvatarUrl: self?.avatarUrl ?? null };
}

export const RECENT_CHATS_KEY = ['rig', 'sessions', 'recentAcrossRigs'];

/** Delay before asking again for a started session: its row is written once its store bootstraps. */
export const STARTED_ROW_MS = 1_500;

/**
 * A session Rig starts (a Feed card, Home chat) shows in the rail at once: the recent chats are asked
 * for again now, and again once its row is written.
 */
export function useRefreshChatsOnStart(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      events.on(rigStartSessionChannel, () => {
        void queryClient.invalidateQueries({ queryKey: RECENT_CHATS_KEY });
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: RECENT_CHATS_KEY }), STARTED_ROW_MS);
      }),
    [queryClient]
  );
}

/**
 * Which of these chats run in this window right now: working, or waiting on the person (an
 * approval). Read off their live stores, so the rail says "Working" the moment one starts.
 */
function useLiveChats(chats: readonly { id: string }[] | undefined): ReadonlyMap<string, 'running' | 'needs_you'> {
  const [live, setLive] = useState<ReadonlyMap<string, 'running' | 'needs_you'>>(new Map());
  useEffect(
    () =>
      autorun(() => {
        const next = new Map<string, 'running' | 'needs_you'>();
        for (const chat of chats ?? []) {
          const held = rigSessionRegistry.get<RigChatStore>(chat.id);
          if (!held || (held as { kind?: unknown }).kind !== 'live' || held.disposed) continue;
          if (held.permissionQueue.length > 0) next.set(chat.id, 'needs_you');
          else if (held.affordances.isWorking) next.set(chat.id, 'running');
        }
        setLive((prev) => (sameMap(prev, next) ? prev : next));
      }),
    [chats]
  );
  return live;
}

function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
