import { useQueries } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { getReadMarkersVersion, readLastSeen, subscribeReadMarkers } from '@renderer/features/spaces/room-read-marker';
import { rpc } from '@renderer/lib/ipc';
import type { RigNotification, RigNotificationSpaceSummary } from '@shared/rig/notifications';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { deriveFaceReasons, unreadMentionsBySpace, type FaceReason } from './face-reasons';

/**
 * Each space's reason faces (`face-reasons.ts`), for the Spaces rows and the
 * topic lines alike. Names and pictures come from each space's members, the
 * same read (and cache) the Room uses. The read position is the relay's
 * cursor when the notifications summary has it, else this computer's.
 */
export function useFaceReasons(input: {
  bindingIds: readonly string[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  summarySpaces: readonly RigNotificationSpaceSummary[];
  activity: readonly RigNotification[] | null;
  selfUserId: string | null;
  enabled: boolean;
}): Map<string, FaceReason[]> {
  useSyncExternalStore(subscribeReadMarkers, getReadMarkersVersion);
  const members = useQueries({
    queries: input.bindingIds.map((bindingId) => ({
      queryKey: ['rig', 'spacesConnection', 'listMembers', bindingId],
      queryFn: () => rpc.rig.spacesConnection.listMembers({ bindingId }),
      staleTime: 60_000,
      enabled: input.enabled,
    })),
  });
  if (!input.enabled) return new Map();
  const mentions = unreadMentionsBySpace(input.activity ?? []);
  const summary = new Map(input.summarySpaces.map((s) => [s.bindingId, s]));
  return new Map(
    input.bindingIds.map((bindingId, i) => {
      const listed = members[i]?.data;
      return [
        bindingId,
        deriveFaceReasons({
          selfUserId: input.selfUserId,
          mentions: mentions.get(bindingId) ?? [],
          status: input.statusByBinding.get(bindingId),
          cursor: summary.get(bindingId)?.lastReadSeq ?? readLastSeen(bindingId),
          members: listed?.success ? listed.data : [],
        }),
      ];
    })
  );
}
