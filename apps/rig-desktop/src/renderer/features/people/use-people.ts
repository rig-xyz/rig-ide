import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { RigWorkspaceBinding } from '@shared/rig/account';
import type { RigPerson } from '@shared/rig/rig-share';

/**
 * Under `['rig', 'account']` on purpose: accepting an invite already
 * invalidates that prefix (the bell, Home), so Your people refreshes with it.
 * Main keeps its own one-minute cache and clears it on the same events.
 */
export const PEOPLE_QUERY_KEY = ['rig', 'account', 'people'] as const;

/**
 * Your people. `supported` is `null` while loading, `false` when the relay
 * is too old for `/v1/me/people` or couldn't be read (callers fall back to
 * today's email-only behavior), `true` otherwise.
 */
export function usePeople(enabled = true): { supported: boolean | null; people: RigPerson[] } {
  const query = useQuery({
    queryKey: PEOPLE_QUERY_KEY,
    queryFn: () => rpc.rig.share.people(),
    staleTime: 60_000,
    enabled,
  });
  if (!query.data) return { supported: query.isError ? false : null, people: [] };
  if (!query.data.success) return { supported: false, people: [] };
  return query.data.data;
}

export const WORKSPACES_QUERY_KEY = ['rig', 'account', 'workspaces'] as const;

/**
 * Your spaces (`kind: 'space'` bindings), never your rigs. `null` while the
 * list hasn't loaded, so callers can wait rather than show a rig by mistake.
 */
export function useMySpaces(): RigWorkspaceBinding[] | null {
  const query = useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => rpc.rig.account.workspaces(),
  });
  if (!query.data) return query.isError ? [] : null;
  if (!query.data.success) return [];
  return query.data.data.filter((binding) => binding.kind === 'space');
}
