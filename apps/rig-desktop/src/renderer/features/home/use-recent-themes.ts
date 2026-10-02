import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { RigRecentThemes } from '@shared/rig/recent-themes';

export const RECENT_THEMES_QUERY_KEY = ['rig', 'recentThemes'];

/** Home's polling cadence, the same as the Spaces rows' live status (`use-space-status.ts`). */
const RECENT_THEMES_POLL_MS = 20_000;

/**
 * Home's one read of the relay's Room themes of the last 24h: it feeds both
 * "Across your spaces today" and each Spaces row's topic, never a call per
 * row. Refetched on window focus and on Home's polling cadence. `cached` is
 * this account's last answer from this computer, shown until `live` lands.
 * Keyed by account, so a switch never shows another account's topics; it
 * waits until Home knows the account, so a launch asks once, not twice.
 */
export function useRecentThemes(
  wanted: boolean,
  accountId: string | null | undefined
): { live: RigRecentThemes | undefined; cached: RigRecentThemes | undefined } {
  const enabled = wanted && typeof accountId === 'string';
  const live = useQuery({
    queryKey: [...RECENT_THEMES_QUERY_KEY, 'get', accountId],
    queryFn: () => rpc.rig.recentThemes.get(),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? RECENT_THEMES_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
  const cached = useQuery({
    queryKey: [...RECENT_THEMES_QUERY_KEY, 'cached', accountId],
    queryFn: () => rpc.rig.recentThemes.cached(),
    enabled,
    staleTime: Infinity,
  });
  return {
    live: enabled ? live.data : undefined,
    cached: enabled ? cached.data : undefined,
  };
}
