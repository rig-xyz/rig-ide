import { useQueryClient } from '@tanstack/react-query';
import { FolderDown } from 'lucide-react';
import { useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { Button } from '@renderer/lib/ui/button';
import { MY_INVITES_KEY_PREFIX, type MyInviteRow } from './invites-inbox';

/**
 * One invite addressed to ME (`rig.share.listMyInvites`, the relay's
 * invitee plane, shipped 2026-08), as the topbar bell lists it. The bell
 * itself is now the Activity bell
 * (`features/notifications/activity-bell.tsx`), which lists these first,
 * then notifications; the polling and the account-scoped key described
 * below live there.
 *
 * Accept is SERVER-SIDE membership first, by design: the invitee plane never
 * exposes the invite secret. Round: rig attach — a joined row no longer just
 * points at Home; it offers "Set up locally" right there, driving the same
 * `rpc.rig.join.attach` flow Home's "Download" uses (member-gated, no
 * invite secret needed), opening the result the normal way on success.
 *
 * Lane J ("boom, you're in"): Accept now runs that attach itself, straight
 * after the membership call, and opens the space — the same one-click
 * sequence as Home's `PendingInviteInline`. "Set up locally" survives only
 * as the retry when the attach half fails after a successful accept.
 *
 * Feedback round fix: the query key is now account-scoped
 * (`invites-inbox.ts`'s `myInvitesQueryKey`) — the old bare key had no
 * account dimension, so switching signed-in accounts mid-session could
 * still show a PREVIOUS account's cached "no invites" rather than an
 * honest fresh read (see that module's own header comment for the bug
 * report this traces to). The empty state also now names which email the
 * search actually ran against (`emptyInvitesMessage`), via the same
 * `rpc.rig.account.me()` read the topbar identity pill already makes.
 */
export function InviteRow({
  row,
  onOpenPath,
  onClose,
}: {
  row: MyInviteRow;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'joining' | 'declining' | 'joined'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // `rig attach` with no `targetDir` lands the rig in `<home>/<slug>` on its
  // own (rig home round: no picker, same as Home's "Download"). On success,
  // the same first-sync handoff `rigs-rail.tsx`'s "Download" uses — see
  // `lib/just-attached.ts` — then close the bell and open the space.
  const attach = async (): Promise<string | null> => {
    try {
      const result = await rpc.rig.join.attach({ bindingId: row.bindingId });
      if (!result.success) return result.error.message;
      markJustAttachedSyncing(result.data.localPath, result.data.syncing);
      onClose();
      onOpenPath(result.data.localPath);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Could not set up the rig locally.';
    }
  };

  const accept = async () => {
    setPhase('joining');
    setError(null);
    const result = await rpc.rig.share.acceptMyInvite({ id: row.id });
    if (!result.success) {
      setPhase('idle');
      setError(result.error.message);
      return;
    }
    // Membership changed server-side: the rig now belongs in Home's shared
    // list, and this invite will drop from the next list read.
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
    const attachError = await attach();
    // Accepted but not set up here: the joined row stays, with the error
    // and a "Set up locally" retry, so the outcome is legible.
    if (attachError) {
      setSetupError(attachError);
      setPhase('joined');
    }
  };

  const decline = async () => {
    setPhase('declining');
    setError(null);
    const result = await rpc.rig.share.declineMyInvite({ id: row.id });
    if (!result.success) {
      setPhase('idle');
      setError(result.error.message);
      return;
    }
    // No ceremony: the per-user hide is done; the row disappears with the list.
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
  };

  const setUpLocally = async () => {
    setSettingUp(true);
    setSetupError(null);
    setSetupError(await attach());
    setSettingUp(false);
  };

  return (
    <div className="flex flex-col gap-1.5 px-1.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-text-primary min-w-0 flex-1 truncate text-xs font-medium">
          {row.label}
        </span>
        <span className="bg-bg-2 text-text-secondary rounded-chip shrink-0 px-1.5 py-0.5 font-mono text-xs">
          {row.roleLabel}
        </span>
      </div>
      <div className="text-text-muted flex items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate">{row.inviterLabel}</span>
        <span className="shrink-0 font-mono text-xs">
          {relativeTime(Date.parse(row.createdAt), Date.now())}
        </span>
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
      {phase === 'joined' ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void setUpLocally()}
            disabled={settingUp}
            className="text-accent flex shrink-0 items-center gap-1 self-start text-xs transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            <FolderDown className="size-3" strokeWidth={1.5} />
            {settingUp ? 'Setting up…' : 'Set up locally'}
          </button>
          {setupError && <p className="text-danger text-xs">{setupError}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            onClick={() => void accept()}
            disabled={phase !== 'idle'}
            className="shrink-0"
          >
            {phase === 'joining' ? 'Joining…' : 'Accept'}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void decline()}
            disabled={phase !== 'idle'}
            className="shrink-0"
          >
            {phase === 'declining' ? 'Declining…' : 'Decline'}
          </Button>
        </div>
      )}
    </div>
  );
}
