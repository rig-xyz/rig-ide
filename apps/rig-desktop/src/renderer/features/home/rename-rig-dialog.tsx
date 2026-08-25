import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';

/**
 * The rigs-rail row menu's "Rename…" — same `Dialog`/`DialogContent`/
 * `DialogTitle` shell `create-rig-dialog.tsx` uses, scaled down to its one
 * field (name in, Save/Cancel out; no location/sync/import zones to carry
 * here). Drives `rpc.rig.control.rename`, which rewrites `rig.toml`'s
 * `[rig].name` in place (a targeted line edit, not a re-serialize — see
 * `main/rig/rig-toml.ts`) and mirrors the new name into `rig_rigs.name`;
 * `rig.toml` is itself a tapd-synced file, so the rename reaches every
 * other member on its own once tapd picks up the write.
 */
export function RenameRigDialog({
  open,
  onOpenChange,
  bindingId,
  path,
  currentName,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bindingId: string;
  path: string;
  currentName: string | null;
  onRenamed: (name: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>Rename rig</DialogTitle>
          <DialogClose />
        </div>
        {/* Keyed remount per open so a reopened dialog never carries a
            stale draft from the last rig it renamed. */}
        {open && (
          <RenameRigForm
            bindingId={bindingId}
            path={path}
            currentName={currentName}
            onClose={() => onOpenChange(false)}
            onRenamed={onRenamed}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameRigForm({
  bindingId,
  path,
  currentName,
  onClose,
  onRenamed,
}: {
  bindingId: string;
  path: string;
  currentName: string | null;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(currentName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const save = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await rpc.rig.control.rename({ bindingId, path, name: trimmed });
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    onRenamed(result.data.name);
    onClose();
  };

  return (
    <div
      className="flex flex-col gap-3 px-4 pb-4"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.metaKey || event.shiftKey) return;
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="rig-rename" className="text-text-secondary text-xs font-medium">
          Name
        </label>
        <input
          id="rig-rename"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="team-roadmap"
          className="border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted focus:border-border-strong focus-visible:outline-accent rounded-control border px-2 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
        />
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!canSubmit}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
