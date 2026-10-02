import { useEffect } from 'react';
import type { RigNotification } from '@shared/rig/notifications';
import type { RoomSnapshot } from '../types';
import { useForYou, type ForYouState, type ResolvePermission } from '../use-for-you';

/**
 * Works out For you for the Room and hands it up. It draws nothing, and the
 * Room mounts it only while room themes are on: the inbox it reads from
 * (`useSpaceActivity`) is not something a Room without them should pay for.
 */
export function ForYouFeeder({
  bindingId,
  snapshot,
  selfUserId,
  notifications,
  resolvePermission,
  onState,
}: {
  bindingId: string;
  /** The Room's snapshot with your pending sends in it, so a reply you just sent clears its ask at once. */
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** Rows to use instead of the inbox's (the scripted demo). */
  notifications?: readonly RigNotification[];
  /** Where answers go instead of the real RPC (the scripted demo). */
  resolvePermission?: ResolvePermission;
  onState: (state: ForYouState | null) => void;
}) {
  const state = useForYou(bindingId, snapshot, selfUserId, { notifications, resolvePermission });
  const { forYou, ready, arrivals, dismiss, approve, approveAll, reject } = state;
  useEffect(() => {
    onState({ forYou, ready, arrivals, dismiss, approve, approveAll, reject });
  }, [onState, forYou, ready, arrivals, dismiss, approve, approveAll, reject]);
  useEffect(() => () => onState(null), [onState]);
  return null;
}
