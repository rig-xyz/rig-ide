import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSpaceStatus } from '@renderer/features/home/use-space-status';
import { useNotificationSummary } from '@renderer/features/notifications/use-notifications';
import { useMySpaces } from '@renderer/features/people/use-people';
import { rpc } from '@renderer/lib/ipc';
import type { RailSpace } from './model';
import { realSpaceToRail } from './rail-data';

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
    queryKey: ['rig', 'sessions', 'recentAcrossRigs'],
    queryFn: () => rpc.rig.sessions.listRecentAcrossRigs({ limit: 30 }),
    staleTime: 5_000,
  });

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
    return (bindings ?? [])
      .map((binding, i) => {
        const listed = members[i]?.data;
        return {
          updatedAt: Date.parse(binding.updatedAt ?? binding.createdAt) || 0,
          space: realSpaceToRail(
            {
              bindingId: binding.id,
              name: binding.name,
              path: localById.get(binding.id) ?? resolved.data?.[binding.id] ?? null,
              members: listed?.success ? listed.data : null,
              unread: unreadBy.get(binding.id) ?? 0,
              status: statusBy.get(binding.id),
              chats: (chats.data ?? []).filter((c) => c.rigBindingId === binding.id),
            },
            self?.id ?? null,
            now
          ),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((x) => x.space);
    // `members` is a fresh array every render; `membersKey` says when any of it changed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bindings,
    status.data,
    summary.spaces,
    localById,
    resolved.data,
    chats.data,
    membersKey,
    self?.id,
  ]);

  return { spaces, selfName: self?.name ?? null, selfAvatarUrl: self?.avatarUrl ?? null };
}
