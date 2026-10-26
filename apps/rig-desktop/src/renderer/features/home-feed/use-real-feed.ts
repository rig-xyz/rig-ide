import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigFeedChangedChannel } from '@shared/rig/feed';
import { rigNotificationsChangedChannel } from '@shared/rig/notifications';
import type { FeedItem } from './model';
import { toFeedItems } from './real-feed';

export const RIG_FEED_KEY = ['rig', 'feed'] as const;

/**
 * Where Home's Feed stands: loading, the orchestrator's cards, or why there
 * are none to show. Signed out covers no token and an expired one; can't
 * reach is the relay down or answering with an error; unsupported is a relay
 * without the Feed (404).
 */
export type RealFeed =
  | { kind: 'loading' }
  | { kind: 'ready'; items: FeedItem[]; me: string | null }
  | { kind: 'signed-out'; message: string }
  | { kind: 'unreachable'; message: string }
  | { kind: 'unsupported'; message: string };

/**
 * The orchestrator's Feed as Home's cards. Re-read whenever the Feed changes
 * (`feed_changed` from the relay, or an answer or correction made here), when
 * the relay stream reconnects, and, while there is no Feed to show, when the
 * window regains focus; never polled.
 */
export function useRealFeed(): RealFeed {
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
    refetchOnWindowFocus: (query) => (query.state.data?.success ? false : 'always'),
  });
  return useMemo((): RealFeed => {
    if (status === 'pending') return { kind: 'loading' };
    if (!data) return { kind: 'unreachable', message: "Rig can't reach the server right now." };
    if (data.success) return { kind: 'ready', items: toFeedItems(data.data, Date.now()), me: data.data.me };
    const { kind, message } = data.error;
    if (kind === 'notSignedIn' || kind === 'invalidToken') return { kind: 'signed-out', message };
    if (kind === 'unsupported') return { kind: 'unsupported', message };
    return { kind: 'unreachable', message };
  }, [data, status]);
}
