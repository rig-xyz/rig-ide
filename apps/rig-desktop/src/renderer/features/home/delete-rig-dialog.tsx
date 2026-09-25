import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import {
  deriveDeleteRigButtonLabel,
  deriveDeleteRigCopy,
  deriveDeleteRigMode,
  deriveFolderKeptNote,
  type DeleteRigNoun,
} from '@shared/rig/delete-rig';
import { PULSE_QUERY_KEY } from './briefing-spine';

/**
 * The rigs-rail row menu's "Delete rig…"/"Leave rig…" confirm dialog — one
 * component for every role (`deriveDeleteRigMode`'s three modes), rather
 * than three near-identical dialogs, since the only real differences are
 * copy and which relay call (if any) `rpc.rig.rigs.delete` makes.
 *
 * Member count (for the "N people will lose access"/"the other N people"
 * lines): `rpc.rig.share.collaborators` already fetches
 * `GET /v1/me/bindings/:bindingId/members` account-plane (the share
 * popover's autocomplete uses it across several bindings; here it's called
 * with just this one) — minus one for the caller's own row, which is
 * always among the members of a binding they're deleting or leaving. Never
 * fetched for `'local'` mode: there's no relay call to make, so there's
 * nothing genuine to count.
 */
export function DeleteRigDialog({
  open,
  onOpenChange,
  bindingId,
  path,
  name,
  role,
  noun = 'rig',
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bindingId: string;
  /** `null` for a relay-only row with no known local folder — hides the folder/Trash section entirely. */
  path: string | null;
  name: string | null;
  role: string | null;
  /** "space" when opened from Home's Spaces card, so the copy says what the user sees (lane J). */
  noun?: DeleteRigNoun;
  /** Fires once the rig is actually gone from this account's point of view — the caller decides what to do next (e.g. `App.tsx`'s `goHome` when this WAS the currently-open rig). */
  onDeleted?: (trashWarning: string | null) => void;
}) {
  const mode = deriveDeleteRigMode(role);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>{deriveDeleteRigCopy({ mode, name, memberCount: null, noun }).title}</DialogTitle>
          <DialogClose />
        </div>
        {/* Keyed remount per open so a reopened dialog never carries a stale trash checkbox or error from the last rig it acted on. */}
        {open && (
          <DeleteRigForm
            bindingId={bindingId}
            path={path}
            name={name}
            mode={mode}
            noun={noun}
            onClose={() => onOpenChange(false)}
            onDeleted={onDeleted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteRigForm({
  bindingId,
  path,
  name,
  mode,
  noun,
  onClose,
  onDeleted,
}: {
  bindingId: string;
  path: string | null;
  name: string | null;
  mode: ReturnType<typeof deriveDeleteRigMode>;
  noun: DeleteRigNoun;
  onClose: () => void;
  onDeleted?: (trashWarning: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'collaborators', bindingId],
    queryFn: () => rpc.rig.share.collaborators({ bindingIds: [bindingId] }),
    enabled: mode !== 'local',
  });
  // The caller's own row is always among a binding's members — see this
  // module's own header comment for why that's a safe assumption here.
  const memberCount = membersQuery.data?.success ? Math.max(0, membersQuery.data.data.length - 1) : null;

  const copy = deriveDeleteRigCopy({ mode, name, memberCount, noun });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.rig.rigs.delete({ bindingId, path, mode, trashFolder: trash });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['rig', 'recent', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'account', 'workspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'sessions', 'recentAcrossRigs'] });
      void queryClient.invalidateQueries({ queryKey: PULSE_QUERY_KEY });
      onDeleted?.(result.data.trashWarning);
      onClose();
    } catch {
      setError(
        mode === 'leave' ? `Couldn't leave this ${noun}. Try again.` : `Couldn't delete this ${noun}. Try again.`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <p className="text-sm text-text-secondary">{copy.body}</p>

      {path && (
        <div className="flex flex-col gap-1.5 rounded-control border border-border-hairline bg-bg-2 p-2.5">
          <p className="truncate font-mono text-xs text-text-muted">{path}</p>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={trash}
              onChange={(event) => setTrash(event.target.checked)}
              className="size-3.5 rounded-control border border-border-hairline accent-danger"
            />
            Also move the folder to the Trash
          </label>
          {!trash && <p className="text-xs text-text-muted">{deriveFolderKeptNote(path)}</p>}
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Working…' : deriveDeleteRigButtonLabel(mode, noun)}
        </Button>
      </div>
    </div>
  );
}
