import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { myInvitesQueryKey, shapeMyInvites, type MyInviteRow } from './invites-inbox';

const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * The invites addressed to you, for the places that show them with Rig Alpha on, where the
 * Activity bell is put away: Settings › Invites lists them, and that page's entry in Settings'
 * list and your row at the foot of the sidebar carry their count. The same calls under the same keys as the bell
 * (`activity-bell.tsx`), so all of them share one read.
 */
export function useMyInvites(): {
  signedIn: boolean;
  /** The address the invites were looked up for; null until it is known. */
  email: string | null;
  /** Null until the first read answers (or when it fails): not yet "none". */
  rows: MyInviteRow[] | null;
  /** The read failed: the list is not known, and says so rather than "none". */
  failed: boolean;
} {
  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;
  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: signedIn,
  });
  const me = meQuery.data?.success ? meQuery.data.data : null;
  const invitesQuery = useQuery({
    queryKey: myInvitesQueryKey(me?.id ?? null),
    queryFn: () => rpc.rig.share.listMyInvites(),
    enabled: signedIn,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const invites = invitesQuery.data?.success ? invitesQuery.data.data.invites : null;
  const failed = invitesQuery.isError || invitesQuery.data?.success === false;
  return {
    signedIn,
    email: me?.email ?? null,
    rows: invites ? shapeMyInvites(invites) : null,
    failed,
  };
}
