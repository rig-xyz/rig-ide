import { FilePlus, Link, Plus, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { rpc } from '@renderer/lib/ipc';
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
export function AddMenu({
  root,
  onOpenFile,
  onOpenImportDialog,
}: {
  root: string;
  onOpenFile: (absPath: string) => void;
  onOpenImportDialog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(open, triggerRef, { gap: 4, estimatedHeight: 140, estimatedWidth: 200 });

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const newFile = async () => {
    setOpen(false);
    const list = await rpc.rig.files.list(root);
    if (!list.success) {
      toast({ title: "Couldn't create the file", description: list.error.message, variant: 'destructive' });
      return;
    }
    const rootFileNames = list.data.filter((node) => node.kind === 'file').map((node) => node.name);
    const relPath = nextUntitledFileName(rootFileNames);
    const absPath = `${root}/${relPath}`;
    const result = await rpc.rig.files.write(absPath, '');
    if (!result.success) {
      toast({ title: "Couldn't create the file", description: result.error.message, variant: 'destructive' });
      return;
    }
    onOpenFile(absPath);
  };

  const fromFile = async () => {
    setOpen(false);
    let picked: string | undefined;
    try {
      picked = await rpc.app.openSelectAnyFileDialog({
        title: 'Add a file',
        message: 'Choose a file to add to this rig',
      });
    } catch (error) {
      toast({
        title: "Couldn't open the file picker",
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
      return;
    }
    if (!picked) return;

    setBusy(true);
    if (/\.docx$/i.test(picked)) {
      const result = await rpc.rig.importDoc.importDoc({ root, source: { kind: 'file', path: picked } });
      setBusy(false);
      if (!result.success) {
        toast({ title: "Couldn't import that file", description: result.error.message, variant: 'destructive' });
        return;
      }
      onOpenFile(result.data.mdPath);
      return;
    }

    const result = await rpc.rig.importDoc.copyFile({ root, path: picked });
    setBusy(false);
    if (!result.success) {
      toast({ title: "Couldn't add that file", description: result.error.message, variant: 'destructive' });
      return;
    }
    onOpenFile(result.data.absPath);
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
        title="Add a file"
        className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex shrink-0 items-center gap-1 border bg-transparent px-2 py-1 text-xs transition-colors disabled:opacity-60"
      >
        <Plus className="size-3.5" strokeWidth={1.5} />
        {busy ? 'Adding…' : 'Add'}
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{
              position: 'fixed',
              width: Math.max(rect.width, 200),
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
          >
            <button
              type="button"
              role="menuitem"
              onMouseDown={(event) => {
                event.preventDefault();
                void newFile();
              }}
              className="hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
            >
              <FilePlus className="size-3.5 shrink-0" strokeWidth={1.5} />
              New file
            </button>
            <button
              type="button"
              role="menuitem"
              onMouseDown={(event) => {
                event.preventDefault();
                setOpen(false);
                onOpenImportDialog();
              }}
              className="hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
            >
              <Link className="size-3.5 shrink-0" strokeWidth={1.5} />
              From Google Docs link…
            </button>
            <button
              type="button"
              role="menuitem"
              onMouseDown={(event) => {
                event.preventDefault();
                void fromFile();
              }}
              className="hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
            >
              <Upload className="size-3.5 shrink-0" strokeWidth={1.5} />
              From file…
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
