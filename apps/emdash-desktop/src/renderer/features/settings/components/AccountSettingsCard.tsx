import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import type React from 'react';
import { useCallback, useState } from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { IdentityAvatar } from '@renderer/features/sidebar/rig-identity-chip';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import type { RigUser } from '@shared/rig/account';

/**
 * Settings → Account: who is signed in to Rig, and the sign-out control.
 * Mirrors WorkspacesSettingsCard's three states (not signed in / loading /
 * signed in) — both cards read the same `rpc.rig.auth.status()` and
 * `rpc.rig.account.me()` queries.
 */
export function AccountSettingsCard() {
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

  const { phase, signIn } = useRigSignIn();

  if (statusLoading) {
    return <p className="text-sm text-foreground-passive">Loading…</p>;
  }

  if (!signedIn) {
    return (
      <EmptyPanel
        title="Sign in to see your account"
        description="Signing in to Rig turns on comments and workspace sync."
      >
        <Button size="sm" onClick={() => void signIn()} disabled={phase !== 'idle'}>
          {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </Button>
      </EmptyPanel>
    );
  }

  if (meQuery.isLoading) {
    return <p className="text-sm text-foreground-passive">Loading account…</p>;
  }

  const result = meQuery.data;
  if (!result || !result.success) {
    return (
      <EmptyPanel
        title="Couldn't load your account"
        description={result ? result.error.message : 'The relay is unreachable.'}
      >
        <Button variant="outline" size="sm" onClick={() => void meQuery.refetch()}>
          Retry
        </Button>
      </EmptyPanel>
    );
  }

  return <SignedInAccount user={result.data} />;
}

function EmptyPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
      <UserRound className="size-8 text-foreground-passive" />
      <p className="text-sm text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-foreground-passive">{description}</p>
      {children}
    </div>
  );
}

function SignedInAccount({ user }: { user: RigUser }) {
  // `||`, not `??`: name/email can be an empty string as well as null, and an
  // empty label must not survive to render as a blank line.
  const label = user.name || user.email || null;
  // Only show the email as its own row when it isn't already the headline
  // label (i.e. there's a name too) — otherwise it would repeat itself.
  const showEmailRow = Boolean(user.email) && user.email !== label;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3">
        <IdentityAvatar
          name={label}
          avatarUrl={user.avatarUrl}
          sizeClassName="size-10"
          textClassName="text-sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{label || '—'}</p>
          {showEmailRow && <p className="truncate text-xs text-foreground-passive">{user.email}</p>}
        </div>
      </div>
      <SignOutButton />
    </div>
  );
}

function SignOutButton() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const showConfirm = useShowModal('confirmActionModal');
  const [pending, setPending] = useState(false);

  const doSignOut = useCallback(async () => {
    setPending(true);
    const result = await rpc.rig.auth.logout();
    setPending(false);
    if (!result.success) {
      toast({
        title: 'Could not sign out',
        description: result.error.message,
        variant: 'destructive',
      });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
  }, [queryClient, toast]);

  return (
    <Button
      variant="destructive"
      size="sm"
      className="self-start"
      disabled={pending}
      onClick={() =>
        showConfirm({
          title: 'Sign out of Rig?',
          description:
            "This signs you out of the rig CLI everywhere on this machine — every terminal, not just here. It won't stop file sync: each workspace keeps syncing on its own connection, untouched by this. But comments and your workspace list will go dark here until you sign back in.",
          confirmLabel: 'Sign out',
          variant: 'destructive',
          onSuccess: () => void doSignOut(),
        })
      }
    >
      Sign out
    </Button>
  );
}
