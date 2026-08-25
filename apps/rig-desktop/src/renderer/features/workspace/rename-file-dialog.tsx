import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.3): the tree row context
 * menu's "Rename" — same `Dialog`/`DialogContent`/`DialogTitle` shell and
 * name-in/Save-Cancel-out shape as `home/rename-rig-dialog.tsx`, scaled to
 * one entry (file or folder) instead of a rig. Drives `rpc.rig.files.rename`
 * (`main/rig/files.ts`, new this round — a plain `fs.rename` scoped to the
 * entry's own parent directory, no overwrite). The tree's own live
 * `fs.watch` subscription (`file-tree.tsx`) picks up the rename and
 * refetches on its own — nothing to invalidate here.
 */
export function RenameFileDialog({
  open,
  onOpenChange,
  absPath,
  currentName,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  absPath: string;
  currentName: string;
  onRenamed: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>Rename</DialogTitle>
          <DialogClose />
        </div>
        {/* Keyed remount per open so a reopened dialog never carries a
            stale draft from the last entry it renamed. */}
        {open && (
          <RenameFileForm
            absPath={absPath}
            currentName={currentName}
            onClose={() => onOpenChange(false)}
            onRenamed={onRenamed}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameFileForm({
  absPath,
  currentName,
  onClose,
  onRenamed,
}: {
  absPath: string;
  currentName: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== currentName && !busy;

  const save = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await rpc.rig.files.rename(absPath, trimmed);
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    onRenamed();
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
        <label htmlFor="rig-file-rename" className="text-text-secondary text-xs font-medium">
          Name
        </label>
        <input
          id="rig-file-rename"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
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
