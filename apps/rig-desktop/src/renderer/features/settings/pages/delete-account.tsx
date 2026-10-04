import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { settingsRow } from '../settings-pages';
import { SettingsRow } from '../settings-row';

/**
 * Settings › Account › Delete account. The relay deletes the account 7 days
 * after the request (`POST /v1/me/delete`) and signing back in before then
 * cancels it. The request revokes every token at once, so this computer then
 * signs out the same way Sign out does (`rpc.rig.auth.deleteAccount`).
 *
 * The scheduled date is kept under `DELETION_QUERY_KEY` for the rest of the
 * session, so the page still shows it once it has flipped to signed out.
 */

export const DELETION_QUERY_KEY = ['rig', 'accountDeletion', 'scheduledAt'] as const;

/** The dialog's confirm field accepts this word or the account's email. */
const CONFIRM_WORD = 'delete';

export function formatDeletionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function confirmationMatches(typed: string, email: string | null): boolean {
  const value = typed.trim().toLowerCase();
  if (!value) return false;
  return value === CONFIRM_WORD || (email !== null && value === email.trim().toLowerCase());
}

/** The row. With a date it says when; otherwise it offers the button. */
export function DeleteAccountRow({
  email,
  scheduledAt,
}: {
  email: string | null;
  scheduledAt: string | null;
}) {
  const row = settingsRow('delete-account')!;
  const [open, setOpen] = useState(false);
  if (scheduledAt) {
    return (
      <SettingsRow
        id={row.id}
        label="Account deletion scheduled"
        description={`Your account will be deleted on ${formatDeletionDate(scheduledAt)}.`}
        detail={
          <p className="text-xs leading-normal text-text-muted">
            Sign in again before then to keep it.
          </p>
        }
      />
    );
  }
  return (
    <>
      <SettingsRow
        id={row.id}
        label={<span className="text-danger">{row.label}</span>}
        description={row.description}
        control={
          <Button variant="destructive" size="xs" onClick={() => setOpen(true)}>
            Delete account…
          </Button>
        }
      />
      <DeleteAccountDialog open={open} onOpenChange={setOpen} email={email} />
    </>
  );
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogClose />
        </div>
        {/* Remounted per open, so a reopened dialog starts empty. */}
        {open && <DeleteAccountForm email={email} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccountForm({ email, onClose }: { email: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = confirmationMatches(typed, email);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.rig.auth.deleteAccount();
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      const { deletionScheduledAt, signedOut } = result.data;
      queryClient.setQueryData(DELETION_QUERY_KEY, deletionScheduledAt);
      // The same clean-up Sign out does.
      roomSourceCache.clear();
      void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
      toast({
        title: `Your account will be deleted on ${formatDeletionDate(deletionScheduledAt)}.`,
        description: 'Sign in again before then to keep it.',
      });
      if (!signedOut) {
        toast({
          title: 'Could not sign out on this computer',
          description: 'Use Sign out to finish.',
          variant: 'destructive',
        });
      }
      onClose();
    } catch {
      setError("Couldn't delete your account. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirmHint = email ? `Type ${email} or delete to confirm.` : 'Type delete to confirm.';
  return (
    <form
      className="flex flex-col gap-3 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ul
        className="flex list-disc flex-col gap-1 pl-4 text-sm text-text-secondary"
        data-testid="delete-account-consequences"
      >
        <li>Rig deletes your account in 7 days.</li>
        <li>You are signed out everywhere right away.</li>
        <li>Spaces you share are handed to another member.</li>
        <li>Spaces only you are in are deleted.</li>
        <li>Your messages in shared spaces stay and show as Former member.</li>
        <li>Your files on this computer are not touched.</li>
        <li>Signing back in within 7 days cancels it.</li>
        <li>Spaces handed to someone else stay with them if you come back.</li>
      </ul>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="delete-account-confirm" className="text-xs text-text-muted">
          {confirmHint}
        </label>
        <input
          id="delete-account-confirm"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={email ?? CONFIRM_WORD}
          className="rounded-control border border-border-hairline bg-bg-1 px-2 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" size="sm" disabled={!ready || busy}>
          {busy ? 'Deleting…' : 'Delete account'}
        </Button>
      </div>
    </form>
  );
}
