import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigFeedChangedChannel } from '@shared/rig/feed';
import { rigNotificationsChangedChannel } from '@shared/rig/notifications';
import type { FeedItem } from './model';
import { toFeedItems } from './real-feed';

export const RIG_FEED_KEY = ['rig', 'feed'] as const;

/**
 * The orchestrator's Feed as Home's cards; undefined until the relay has
 * answered, and null when there is none to show: not signed in, or a relay
 * without the Feed (Home keeps its demo).
 * Re-read whenever the Feed changes (`feed_changed` from the relay, or an
 * answer or correction made here) and when the relay stream reconnects;
 * never polled.
 */
export function useRealFeed(): { items: FeedItem[]; me: string | null } | null | undefined {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: RIG_FEED_KEY });
    const offFeed = events.on(rigFeedChangedChannel, refresh);
    // A (re)connected stream may have missed `feed_changed` while it was down.
    const offStream = events.on(rigNotificationsChangedChannel, ({ reason }) => {
      if (reason === 'connected') refresh();
    });
    return () => {
      offFeed();
      offStream();
    };
  }, [queryClient]);
  const { data, status } = useQuery({
    queryKey: RIG_FEED_KEY,
    queryFn: () => rpc.rig.feed.get(),
    staleTime: Infinity,
  });
  return useMemo(
    () =>
      status === 'pending' ? undefined : data?.success ? { items: toFeedItems(data.data, Date.now()), me: data.data.me } : null,
    [data, status]
  );
}
