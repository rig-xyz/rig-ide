import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows } from '../settings-row';
import { DELETION_QUERY_KEY, DeleteAccountRow } from './delete-account';

/**
 * Settings › Account: who you are signed in as, and Sign out. The same
 * `rpc.rig.auth`/`rpc.rig.account` calls `UserPill` makes, under the same
 * query keys, so the two share a cache.
 *
 * There is one sign-out, not two: `rpc.rig.auth.logout` runs `rig logout`,
 * which clears the token the Rig command line also reads
 * (`~/.config/rig/config.json`), so the app signing out IS the command line
 * signing out. It also pauses sync for this account's rigs and spaces on
 * this computer (`main/rig/auth.ts`'s `logout`). Delete account
 * (`delete-account.tsx`) ends with the same sign-out.
 */
export function AccountPage() {
  const queryClient = useQueryClient();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = status?.signedIn ?? false;

  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: signedIn,
  });

  // Set by Delete account for the rest of the session; never fetched.
  const { data: deletionRequestedAt } = useQuery<string | null>({
    queryKey: DELETION_QUERY_KEY,
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });

  const { phase, signIn } = useRigSignIn();
  const signedInRow = settingsRow('signed-in')!;

  if (statusLoading) {
    return <p className="text-text-muted py-3.5 text-xs">Loading…</p>;
  }

  if (!signedIn) {
    return (
      <SettingsRows>
        <SettingsRow
          id={signedInRow.id}
          label="Not signed in"
          description="Sign in to sync your spaces and share them with people."
          control={
            <Button size="sm" onClick={() => void signIn()} disabled={phase !== 'idle'}>
              {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
            </Button>
          }
        />
        {deletionRequestedAt && <DeleteAccountRow email={null} scheduledAt={deletionRequestedAt} />}
      </SettingsRows>
    );
  }

  const user = meQuery.data?.success ? meQuery.data.data : null;
  const name = user?.name || user?.email || null;
  const email = user?.email && user.email !== name ? user.email : null;

  const doSignOut = async () => {
    const result = await rpc.rig.auth.logout();
    if (!result.success) {
      toast({ title: 'Could not sign out', description: result.error.message, variant: 'destructive' });
      return;
    }
    roomSourceCache.clear(); // no Room of this account outlives it
    setConfirmingSignOut(false);
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
  };

  const signOutRow = settingsRow('sign-out')!;
  return (
    <SettingsRows>
      <SettingsRow
        id={signedInRow.id}
        leading={
          <IdentityAvatar name={name} avatarUrl={user?.avatarUrl ?? null} sizeClassName="size-9" textClassName="text-xs" />
        }
        label={name ?? 'Signed in to Rig'}
        description={email ?? 'Signed in to Rig on this computer.'}
      />
      <SettingsRow
        id={signOutRow.id}
        label={signOutRow.label}
        description={signOutRow.description}
        control={
          confirmingSignOut ? (
            <>
              <Button variant="ghost" size="xs" onClick={() => setConfirmingSignOut(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="xs" onClick={() => void doSignOut()}>
                Sign out
              </Button>
            </>
          ) : (
            <Button variant="outline" size="xs" onClick={() => setConfirmingSignOut(true)}>
              Sign out…
            </Button>
          )
        }
      />
      <DeleteAccountRow
        email={user?.email ?? null}
        scheduledAt={user?.deletionScheduledAt ?? deletionRequestedAt ?? null}
      />
    </SettingsRows>
  );
}
