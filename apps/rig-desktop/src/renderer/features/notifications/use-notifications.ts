import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import {
  EMPTY_NOTIFICATION_SUMMARY,
  rigNotificationsChangedChannel,
  type MacNotificationPermission,
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

export const NOTIFICATION_PERMISSION_KEY = ['rig', 'notifications', 'permission'];

/**
 * macOS's permission for rig. Re-read when the window comes back (the
 * person may have just been to System Settings).
 */
export function useNotificationPermission(): MacNotificationPermission | null {
  const { data } = useQuery({
    queryKey: NOTIFICATION_PERMISSION_KEY,
    queryFn: () => rpc.rig.notifications.permission(),
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });
  return data ?? null;
}

/**
 * Ask macOS (its own prompt, shown once) and re-read the answer a few
 * times while the prompt is up; focus coming back re-reads it too.
 */
export function useRequestNotificationPermission(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void rpc.rig.notifications.requestPermission();
    for (const ms of [500, 2_000, 5_000, 10_000]) {
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: NOTIFICATION_PERMISSION_KEY }), ms);
    }
  };
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
        name: null,
        latestDirect: null,
        level: 'all' as NotificationLevel,
        lastReadSeq: 0,
        spaceUnread: 0,
        directUnread: 0,
        directUnreadNoMessage: 0,
        known: false,
      };
}
