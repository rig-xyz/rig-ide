import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FolderSync } from 'lucide-react';
import type React from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import type { RigWorkspaceBinding } from '@shared/rig/account';
import { formatLastSynced, hubWorkspaceUrl, isWorkspaceLive } from './workspace-sync-status';

/**
 * Settings → Workspaces: the rigs synced to the signed-in Rig account, read
 * from `rpc.rig.account.workspaces()`. A calm, factual status list — not a
 * dashboard — so a row states name, relay host, role, and how long ago it
 * last synced, plus a small dot for "synced within the last minute".
 *
 * Three states this always has to handle: not signed in (sign-in prompt,
 * sharing the Part 2 flow), signed in with zero workspaces (explains how one
 * shows up), and the request failing (shows the relay's own message).
 */
export function WorkspacesSettingsCard() {
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = status?.signedIn ?? false;

  const workspacesQuery = useQuery({
    queryKey: ['rig', 'account', 'workspaces'],
    queryFn: () => rpc.rig.account.workspaces(),
    enabled: signedIn,
  });

  const { phase, signIn } = useRigSignIn();

  if (statusLoading) {
    return <p className="text-sm text-foreground-passive">Loading…</p>;
  }

  if (!signedIn) {
    return (
      <EmptyPanel
        title="Sign in to see your workspaces"
        description="Workspaces synced to your Rig account show up here."
      >
        <Button size="sm" onClick={() => void signIn()} disabled={phase !== 'idle'}>
          {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </Button>
      </EmptyPanel>
    );
  }

  if (workspacesQuery.isLoading) {
    return <p className="text-sm text-foreground-passive">Loading workspaces…</p>;
  }

  const result = workspacesQuery.data;
  if (!result || !result.success) {
    return (
      <EmptyPanel
        title="Couldn't load your workspaces"
        description={result ? result.error.message : 'The relay is unreachable.'}
      >
        <Button variant="outline" size="sm" onClick={() => void workspacesQuery.refetch()}>
          Retry
        </Button>
      </EmptyPanel>
    );
  }

  const workspaces = result.data;
  if (workspaces.length === 0) {
    return (
      <EmptyPanel
        title="No workspaces yet"
        description={
          <>
            A workspace appears here once it&apos;s bound to your account — run{' '}
            <code className="font-mono text-foreground-muted">rig init</code> in a folder, then{' '}
            <code className="font-mono text-foreground-muted">rig sync</code>.
          </>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {workspaces.map((workspace) => (
        <WorkspaceRow key={workspace.id} workspace={workspace} />
      ))}
    </div>
  );
}

function EmptyPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
      <FolderSync className="size-8 text-foreground-passive" />
      <p className="text-sm text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-foreground-passive">{description}</p>
      {children}
    </div>
  );
}

function WorkspaceRow({ workspace }: { workspace: RigWorkspaceBinding }) {
  const live = isWorkspaceLive(workspace.lastSyncedAt);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live ? 'bg-foreground-success' : 'bg-foreground-passive'
        )}
        title={live ? 'Synced within the last minute' : 'Idle'}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-sm font-medium text-foreground">{workspace.name}</p>
          <Badge variant="secondary">{workspace.role}</Badge>
        </div>
        <p className="truncate text-xs text-foreground-passive">{workspace.relayHost}</p>
      </div>
      <span className="shrink-0 text-xs text-foreground-passive">
        {formatLastSynced(workspace.lastSyncedAt)}
      </span>
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => confirmOpenExternalLink(hubWorkspaceUrl(workspace.id))}
              aria-label={`Manage ${workspace.name} on the hub`}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Manage on hub</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
