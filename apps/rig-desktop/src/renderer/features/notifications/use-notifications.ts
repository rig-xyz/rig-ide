import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import {
  EMPTY_NOTIFICATION_SUMMARY,
  rigNotificationsChangedChannel,
  type NotificationLevel,
  type RigNotification,
  type RigNotificationSpaceSummary,
  type RigNotificationSummary,
} from '@shared/rig/notifications';

/**
 * The renderer's read of notifications state. Main holds the live summary
 * (it keeps the relay stream open, `main/rig/notifications/service.ts`) and
 * says when it changed on `rigNotificationsChangedChannel`; these hooks
 * refetch then, so there's no polling here.
 */

export const NOTIFICATION_SUMMARY_KEY = ['rig', 'notifications', 'summary'];
export const NOTIFICATION_ACTIVITY_KEY = ['rig', 'notifications', 'activity'];

/** Refetch everything notification-shaped when main says something changed. Mount once (App). */
export function useNotificationsInvalidation(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      events.on(rigNotificationsChangedChannel, () => {
        void queryClient.invalidateQueries({ queryKey: NOTIFICATION_SUMMARY_KEY });
        void queryClient.invalidateQueries({ queryKey: NOTIFICATION_ACTIVITY_KEY });
      }),
    [queryClient]
  );
}

export function useNotificationSummary(): RigNotificationSummary {
  const { data } = useQuery({
    queryKey: NOTIFICATION_SUMMARY_KEY,
    queryFn: () => rpc.rig.notifications.summary(),
    staleTime: Infinity,
  });
  return data ?? EMPTY_NOTIFICATION_SUMMARY;
}

/** Activity: unread and read rows about you, newest first (shared by the bell and Home's rows). */
export function useActivity(enabled = true): RigNotification[] | null {
  const { data } = useQuery({
    queryKey: NOTIFICATION_ACTIVITY_KEY,
    queryFn: () => rpc.rig.notifications.activity({ limit: 50 }),
    enabled,
    staleTime: Infinity,
  });
  return data?.success ? data.data : null;
}

/** The newest unread row about you in one space, if any. */
export function useLatestDirect(bindingId: string): RigNotification | null {
  const activity = useActivity();
  return activity?.find((n) => n.bindingId === bindingId && n.readAt === null) ?? null;
}

/** One space's counts and level; zeros and 'all' until known. */
export function useSpaceNotifications(bindingId: string | null | undefined): RigNotificationSpaceSummary & {
  known: boolean;
} {
  const summary = useNotificationSummary();
  const found = bindingId ? summary.spaces.find((s) => s.bindingId === bindingId) : undefined;
  return found
    ? { ...found, known: true }
    : {
        bindingId: bindingId ?? '',
        level: 'all' as NotificationLevel,
        lastReadSeq: 0,
        spaceUnread: 0,
        directUnread: 0,
        directUnreadNoMessage: 0,
        known: false,
      };
}
