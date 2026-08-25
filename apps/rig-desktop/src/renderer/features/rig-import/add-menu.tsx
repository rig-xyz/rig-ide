import { FilePlus, FolderPlus, Link, Plus, RefreshCw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Popover, PopoverMenuItem, PopoverSeparator } from '@renderer/lib/ui/popover';
import { nextUntitledFileName } from './add-menu-logic';

/**
 * The file browser header's Add action (replaces the old plain "Import"
 * button — re-plumbing entries, not rebuilding `ImportDocDialog`, which
 * this still opens for the Google Docs link path). Three rows, icon+word:
 *
 * - "New file" — an untitled-N.md written straight into the rig root via
 *   the existing `files.write` RPC, opened in the artifact view ready to
 *   edit. N is the first free `untitled-N.md` at the root (never a
 *   collision — see `add-menu-logic.ts`'s `nextUntitledFileName`).
 * - "From Google Docs link…" — the existing `ImportDocDialog`, which
 *   already opens in link mode by default (`EMPTY_IMPORT_SOURCE`).
 * - "From file…" — a NEW native picker with no extension filter: a .docx
 *   routes through the same `importDoc` pipeline the dialog's docx tile
 *   uses; anything else is copied into the rig root as-is
 *   (`rpc.rig.importDoc.copyFile`, collision-safe naming via the same
 *   `wx`/uniqueness conventions `import-doc.ts` uses for its own writes).
 */
export function NewMenu({
  root,
  rootId,
  onOpenFile,
  onOpenImportDialog,
}: {
  root: string;
  rootId: string;
  onOpenFile: (absPath: string) => void;
  onOpenImportDialog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const newFile = async () => {
    setOpen(false);
    try {
      const list = await rpc.rig.files.list({ rootId });
      if (!list.success) {
        toast({
          title: "Couldn't create the file",
          description: list.error.message,
          variant: 'destructive',
        });
        return;
      }
      const rootFileNames = list.data
        .filter((node) => node.kind === 'file')
        .map((node) => node.name);
      const relPath = nextUntitledFileName(rootFileNames);
      const absPath = `${root}/${relPath}`;
      const result = await rpc.rig.files.write({ rootId, relativePath: relPath, content: '' });
      if (!result.success) {
        toast({
          title: "Couldn't create the file",
          description: result.error.message,
          variant: 'destructive',
        });
        return;
      }
      onOpenFile(absPath);
    } catch {
      toast({
        title: "Couldn't create the file",
        description: 'Try again.',
        variant: 'destructive',
      });
    }
  };

  const newFolder = async () => {
    setOpen(false);
    try {
      const list = await rpc.rig.files.list({ rootId });
      if (!list.success) {
        toast({
          title: "Couldn't create the folder",
          description: list.error.message,
          variant: 'destructive',
        });
        return;
      }
      const taken = new Set(
        list.data.filter((node) => node.kind === 'dir').map((node) => node.name)
      );
      let name = 'New folder';
      for (let n = 2; taken.has(name); n += 1) name = `New folder ${n}`;
      const result = await rpc.rig.files.makeDirectory({ rootId, name });
      if (!result.success) {
        toast({
          title: "Couldn't create the folder",
          description: result.error.message,
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: "Couldn't create the folder",
        description: 'Try again.',
        variant: 'destructive',
      });
    }
  };

  const fromFile = async () => {
    setOpen(false);
    let picked: string | undefined;
    try {
      picked = await rpc.app.openSelectAnyFileDialog({
        title: 'Add a file',
        message: 'Choose a file to add to this rig',
      });
    } catch {
      toast({
        title: "Couldn't open the file picker",
        description: 'Try again.',
        variant: 'destructive',
      });
      return;
    }
    if (!picked) return;

    setBusy(true);
    try {
      if (/\.docx$/i.test(picked)) {
        const result = await rpc.rig.importDoc.importDoc({
          rootId,
          source: { kind: 'file', path: picked },
        });
        if (!result.success) {
          toast({
            title: "Couldn't import that file",
            description: result.error.message,
            variant: 'destructive',
          });
          return;
        }
        onOpenFile(`${root}/${result.data.relPath}`);
        return;
      }

      const result = await rpc.rig.importDoc.copyFile({ rootId, path: picked });
      if (!result.success) {
        toast({
          title: "Couldn't add that file",
          description: result.error.message,
          variant: 'destructive',
        });
        return;
      }
      onOpenFile(`${root}/${result.data.relPath}`);
    } catch {
      toast({ title: "Couldn't add that file", description: 'Try again.', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add something to this rig"
        className="flex shrink-0 items-center gap-1 rounded-control border border-border-hairline bg-transparent px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary disabled:opacity-60"
      >
        <Plus className="size-3.5" strokeWidth={1.5} />
        {busy ? 'Adding…' : 'New'}
      </button>
      <Popover
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        gap={4}
        estimatedWidth={200}
        minWidth={200}
      >
        <PopoverMenuItem icon={FilePlus} label="New file" onSelect={() => void newFile()} />
        <PopoverMenuItem icon={FolderPlus} label="New folder" onSelect={() => void newFolder()} />
        <PopoverMenuItem icon={Upload} label="Import file…" onSelect={() => void fromFile()} />
        <PopoverSeparator />
        <PopoverMenuItem
          icon={Link}
          label="Import from Docs…"
          onSelect={() => {
            setOpen(false);
            onOpenImportDialog();
          }}
        />
        {/*
          Named but not yet real. Shown disabled rather than hidden
          because people ask for it constantly and an absent option
          reads as "this product cannot do that", where a greyed one
          with a date-free "coming soon" reads as "not yet". It must
          never look clickable.
        */}
        <div
          role="menuitem"
          aria-disabled="true"
          className="flex w-full cursor-default items-center gap-2 px-2.5 py-1.5 text-left text-sm text-text-muted"
        >
          <RefreshCw className="size-3.5 shrink-0" strokeWidth={1.5} />
          Sync with Drive
          <span className="ml-auto rounded-full border border-border-hairline px-1.5 text-xs text-text-muted">
            Soon
          </span>
        </div>
      </Popover>
    </>
  );
}
