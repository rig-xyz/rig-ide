import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { MY_INVITES_KEY_PREFIX, type MyInviteRow } from '@renderer/features/shell/invites-inbox';
import { NeedsConnection } from '@renderer/features/shell/needs-connection';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import type { WelcomePhase } from './welcome-state';

type OpenPath = (path: string, opts?: { kind?: 'space' }) => void;

/**
 * One invite's Join, end to end: accept, then set it up on this Mac and
 * open it. Accepted but not set up here says so, with Set up again.
 */
function useInviteJoin(invite: MyInviteRow, onOpenPath: OpenPath) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'working' | 'joined'>('idle');
  const [error, setError] = useState<string | null>(null);

  const setUp = async () => {
    setPhase('working');
    setError(null);
    const attached = await rpc.rig.join
      .attach({ bindingId: invite.bindingId, ...(invite.rigName ? { name: invite.rigName } : {}) })
      .catch(() => null);
    if (!attached?.success) {
      setPhase('joined');
      setError(`You joined ${invite.label}, but it couldn't be set up here.`);
      return;
    }
    markJustAttachedSyncing(attached.data.localPath, attached.data.syncing);
    onOpenPath(attached.data.localPath, invite.kind === 'rig' ? undefined : { kind: 'space' });
  };

  const join = async () => {
    setPhase('working');
    setError(null);
    const accepted = await rpc.rig.share.acceptMyInvite({ id: invite.id }).catch(() => null);
    if (!accepted?.success) {
      setPhase('idle');
      setError(accepted ? accepted.error.message : "Rig couldn't accept the invite. Try again.");
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
    await setUp();
  };

  return { phase, error, join: phase === 'joined' ? setUp : join, label: phase === 'joined' ? 'Set up again' : 'Join' };
}

/**
 * First run with invites waiting: the invite is the point, so "Join #name"
 * from the inviter is the one big button and Start fresh a quiet link.
 * Every other invite is listed under it with its own Join.
 */
export function InviteWelcome({
  invites,
  icon,
  onOpenPath,
  onStartFresh,
  startFreshPhase,
  needsConnection,
  children,
}: {
  invites: readonly MyInviteRow[];
  icon: ReactNode;
  onOpenPath: OpenPath;
  onStartFresh: () => void;
  /** Start fresh's own state: starting, waiting for sign-in, or why it failed. */
  startFreshPhase: WelcomePhase;
  needsConnection: boolean;
  /** Under the invites: the invite link field. */
  children?: ReactNode;
}) {
  const [first, ...rest] = invites;
  const primary = useInviteJoin(first!, onOpenPath);
  const working = primary.phase === 'working';
  const starting = startFreshPhase.kind === 'creating' || startFreshPhase.kind === 'signingIn';
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center" data-testid="invite-welcome">
      {icon}
      <p className="font-display text-text-primary text-xl">
        {first!.inviterLabel} invited you to {first!.label}
      </p>
      <div className="flex w-full flex-col items-center gap-2">
        <NeedsConnection blocked={needsConnection}>
          <button
            type="button"
            onClick={() => void primary.join()}
            disabled={working || needsConnection}
            data-testid="invite-welcome-join"
            className="welcome-cta bg-accent text-accent-ink focus-visible:outline-accent inline-flex items-center gap-2 rounded-chip px-6 py-3 text-base font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
          >
            {working && <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />}
            {working ? 'Joining…' : primary.label === 'Join' ? `Join ${first!.label}` : primary.label}
          </button>
        </NeedsConnection>
        {primary.error && <p className="text-danger text-xs">{primary.error}</p>}
      </div>
      {rest.length > 0 && (
        <ul className="flex w-full flex-col gap-1.5" data-testid="invite-welcome-more">
          {rest.map((invite) => (
            <InviteLine key={invite.id} invite={invite} onOpenPath={onOpenPath} needsConnection={needsConnection} />
          ))}
        </ul>
      )}
      {children}
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={onStartFresh}
          disabled={starting || needsConnection}
          className="text-text-muted hover:text-text-primary text-sm transition-colors disabled:pointer-events-none disabled:opacity-60"
        >
          {startFreshPhase.kind === 'creating'
            ? 'Starting…'
            : startFreshPhase.kind === 'signingIn'
              ? 'Waiting for sign-in…'
              : 'Start fresh instead'}
        </button>
        {startFreshPhase.kind === 'error' && <p className="text-danger text-xs">{startFreshPhase.message}</p>}
      </div>
    </div>
  );
}

function InviteLine({
  invite,
  onOpenPath,
  needsConnection,
}: {
  invite: MyInviteRow;
  onOpenPath: OpenPath;
  needsConnection: boolean;
}) {
  const { phase, error, join, label } = useInviteJoin(invite, onOpenPath);
  return (
    <li className="flex flex-col items-center gap-0.5">
      <p className="text-text-muted text-sm">
        {invite.inviterLabel} invited you to {invite.label} ·{' '}
        <button
          type="button"
          onClick={() => void join()}
          disabled={phase === 'working' || needsConnection}
          className="text-accent hover:opacity-80 disabled:pointer-events-none disabled:opacity-50"
        >
          {phase === 'working' ? 'Joining…' : label}
        </button>
      </p>
      {error && <p className="text-danger text-xs">{error}</p>}
    </li>
  );
}
