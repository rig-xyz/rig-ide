import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { Result } from '@emdash/shared';
import type { RigSpaceStatus, RigSpaceStatusError } from '@shared/rig/space-status';

export const SPACE_STATUS_QUERY_KEY = ['rig', 'spaceStatus', 'get'];

/** Gentle by design (design doc): every 20s while Home is mounted, plus a refetch on window focus — react-query already stops polling once nothing reads this query key (Home unmounted), so "while visible" needs no extra plumbing. */
const SPACE_STATUS_POLL_MS = 20_000;

/**
 * Polish round, lane C: the spaces card's + "Needs you"' shared
 * read of `rpc.rig.spaceStatus.get()` — one query, one cache entry, same
 * dedup reasoning `PULSE_QUERY_KEY` already relies on for
 * `BriefingSpine`/`PeopleRail`. `enabled` mirrors `shouldShowPulseSection`'s
 * own gate: no point polling for a signed-out/solo window with no spaces.
 */
export function useSpaceStatus(enabled: boolean): UseQueryResult<Result<RigSpaceStatus[], RigSpaceStatusError>> {
  return useQuery({
    queryKey: SPACE_STATUS_QUERY_KEY,
    queryFn: () => rpc.rig.spaceStatus.get(),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? SPACE_STATUS_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
}
