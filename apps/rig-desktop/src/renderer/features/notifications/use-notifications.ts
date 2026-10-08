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
/** Under the activity key, so the same change event re-reads which rows came in while you were away. */
export const NOTIFICATION_AWAY_KEY = [...NOTIFICATION_ACTIVITY_KEY, 'away'];

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

/** How many direct rows one Space's page asks for. */
export const SPACE_ACTIVITY_LIMIT = 100;
/** Under `NOTIFICATION_ACTIVITY_KEY`, so the same invalidation that refreshes the bell refreshes this too. */
export const spaceActivityKey = (bindingId: string) => [
  ...NOTIFICATION_ACTIVITY_KEY,
  'space',
  bindingId,
];

/**
 * One Space's direct rows, newest first: the page the relay filters by
 * `bindingId`. A relay from before that param rejects it (or ignores it); then
 * this falls back to the cross-Space page (the bell's own) and keeps this
 * Space's rows. Null when the inbox can't be read at all.
 */
export async function fetchSpaceActivity(bindingId: string): Promise<RigNotification[] | null> {
  const ofSpace = (rows: RigNotification[]) => rows.filter((row) => row.bindingId === bindingId);
  try {
    const page = await rpc.rig.notifications.activity({ limit: SPACE_ACTIVITY_LIMIT, bindingId });
    if (page.success) return ofSpace(page.data);
  } catch {
    // fall through to the cross-Space page
  }
  try {
    const page = await rpc.rig.notifications.activity({ limit: 50 });
    return page.success ? ofSpace(page.data) : null;
  } catch {
    return null;
  }
}

/** The Room's inbox: this Space's rows only (see `fetchSpaceActivity`), refetched on the same channel as the bell. Null until read. */
export function useSpaceActivity(bindingId: string, enabled = true): RigNotification[] | null {
  const { data } = useQuery({
    queryKey: spaceActivityKey(bindingId),
    queryFn: () => fetchSpaceActivity(bindingId),
    enabled,
    staleTime: Infinity,
  });
  return data ?? null;
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
