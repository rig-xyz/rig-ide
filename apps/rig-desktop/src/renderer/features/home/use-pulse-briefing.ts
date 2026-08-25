import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { PULSE_QUERY_KEY } from './briefing-spine';
import { derivePulseSectionState, isPulseStale, type PulseSectionState } from './pulse-state';

/**
 * The pulse briefing plus its self-heal, in one place so every surface that
 * shows it stays equally fresh.
 *
 * How the briefing actually comes to exist: the relay generates it from the
 * account's recent change events, narrates it with the model, and caches it
 * per user for ~3 hours. Nothing regenerates it on a schedule — a briefing
 * goes stale sitting in that cache until something asks for a fresh one.
 * That "something" is this hook: whenever a fetch resolves with a briefing
 * older than the TTL, it forces one real regeneration (`refresh: true`).
 *
 * This used to live inside `briefing-spine.tsx`, which only mounts on Home
 * — so a rig's own People card could show an arbitrarily old line for
 * anyone who went straight into a rig and never passed through Home. Same
 * query key, same cache entry, so both surfaces share one fetch and one
 * regeneration rather than racing each other.
 */
export function usePulseBriefing(): {
  state: PulseSectionState;
  refreshing: boolean;
  forceRefresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => rpc.rig.pulse.get({}),
    staleTime: 60_000,
  });
  const [refreshing, setRefreshing] = useState(false);
  // A ref, not state: it guards re-entrancy without becoming a dependency
  // that would re-run the effect below.
  const forcingRef = useRef(false);

  const forceRefresh = useCallback(async () => {
    if (forcingRef.current) return;
    forcingRef.current = true;
    setRefreshing(true);
    try {
      const result = await rpc.rig.pulse.get({ refresh: true });
      queryClient.setQueryData(PULSE_QUERY_KEY, result);
    } finally {
      forcingRef.current = false;
      setRefreshing(false);
    }
  }, [queryClient]);

  useEffect(() => {
    if (!pulseQuery.data?.success) return;
    if (!isPulseStale(pulseQuery.data.data.briefing.generatedAt, Date.now())) return;
    void forceRefresh();
  }, [pulseQuery.data, forceRefresh]);

  return {
    state: derivePulseSectionState({ isLoading: pulseQuery.isLoading, data: pulseQuery.data }),
    refreshing,
    forceRefresh,
  };
}
