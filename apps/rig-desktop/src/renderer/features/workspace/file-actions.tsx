import { Archive, Copy, FolderOpen, Pencil, Pin } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { flushOpenDocs } from '@renderer/features/docs/doc-file-sync';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { Popover, type PopoverAnchor } from '@renderer/lib/ui/popover';
import { relPathFromRoot } from '@shared/rig/file-navigator-categories';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { announceFileMove } from './file-moves';
import { RenameFileDialog } from './rename-file-dialog';
import { ContextMenuItem } from './row-context-menu';

/**
 * The file actions both the tree's row menu (`file-tree.tsx`) and a file's
 * title bar menu (`artifact/file-options-menu.tsx`) offer — one set of
 * handlers and one set of menu rows, so the menus can never disagree
 * about what "Archive" or "Pin to top" does. `FileActionsMenu` is those rows
 * as a whole menu for one file (the title bar's `⋯`, the Files list's
 * right-click), with its own Rename dialog.
 */

/** This rig's pinned relPaths, live across every surface that pins, plus the toggle. */
export function usePinnedPaths(bindingId: string | null | undefined) {
  const [pinned, setPinned] = useState<string[]>([]);
  useEffect(() => {
    if (!bindingId) {
      setPinned([]);
      return;
    }
    let alive = true;
    void rpc.rig.settings.get().then((settings) => {
      if (alive) setPinned(settings.pinnedPathsByRig[bindingId] ?? []);
    });
    const off = events.on(rigSettingsChangedChannel, (settings) => {
      setPinned(settings.pinnedPathsByRig[bindingId] ?? []);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId]);

  const togglePin = useCallback(
    (relPath: string) => {
      if (!bindingId) return;
      const next = pinned.includes(relPath)
        ? pinned.filter((p) => p !== relPath)
        : [...pinned, relPath];
      setPinned(next);
      void rpc.rig.settings.set({ pinnedPathsByRig: { [bindingId]: next } });
    },
    [bindingId, pinned]
  );

  return { pinned, togglePin };
}

/**
 * Archive moves the entry into `_archive/` at the rig root — a real move
 * everyone sharing the rig can see, not a private flag that would make a
 * file vanish for one person and stay put for everyone else. Unsaved edits
 * are written first, and an open tab closes once it has moved. Resolves
 * true once the entry has moved; failures are toasted here.
 */
export async function archiveEntry(
  root: string,
  rootId: string,
  relPath: string
): Promise<boolean> {
  const absPath = `${root}/${relPath}`;
  try {
    await flushOpenDocs(absPath);
    const result = await rpc.rig.files.archive({ rootId, relativePath: relPath });
    if (result.success) {
      announceFileMove({ from: absPath, to: null });
      return true;
    }
    toast({
      title: "Couldn't archive this item",
      description: result.error.message,
      variant: 'destructive',
    });
  } catch {
    toast({
      title: "Couldn't archive this item",
      description: 'Try again.',
      variant: 'destructive',
    });
  }
  return false;
}

/**
 * The shared rows: Pin to top/Unpin (only when `onTogglePin` is given),
 * Copy path, Reveal in Finder, Rename, Archive. Each row runs its action
 * and then `onDone`, which closes whichever menu hosts them.
 */
export function FileActionItems({
  absPath,
  isPinned = false,
  onTogglePin,
  onRename,
  onArchive,
  onDone,
}: {
  absPath: string;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDone: () => void;
}) {
  return (
    <>
      {onTogglePin && (
        <ContextMenuItem
          label={isPinned ? 'Unpin' : 'Pin to top'}
          icon={Pin}
          onSelect={() => {
            onTogglePin();
            onDone();
          }}
        />
      )}
      <ContextMenuItem
        label="Copy path"
        icon={Copy}
        onSelect={() => {
          void rpc.app.clipboardWriteText(absPath);
          onDone();
        }}
      />
      <ContextMenuItem
        label="Reveal in Finder"
        icon={FolderOpen}
        onSelect={() => {
          void rpc.app.showItemInFolder(absPath);
          onDone();
        }}
      />
      <ContextMenuItem
        label="Rename"
        icon={Pencil}
        onSelect={() => {
          onRename();
          onDone();
        }}
      />
      <ContextMenuItem
        label="Archive"
        icon={Archive}
        onSelect={() => {
          onArchive();
          onDone();
        }}
      />
    </>
  );
}

/**
 * One file's actions as a menu: anchored to a button (`ref`) or a point (a
 * right-click). Stays mounted while closed so its Rename dialog outlives
 * the menu that opened it.
 */
export function FileActionsMenu({
  root,
  rootId,
  bindingId,
  absPath,
  anchor,
  onClose,
  align = 'left',
  gap = 2,
}: {
  root: string;
  rootId: string;
  /** Pin to top/Unpin only shows when the rig's binding is known. */
  bindingId?: string | null;
  /** The file the menu is open for; null while closed. */
  absPath: string | null;
  anchor: PopoverAnchor | null;
  onClose: () => void;
  align?: 'left' | 'right';
  gap?: number;
}) {
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const { pinned, togglePin } = usePinnedPaths(bindingId);
  const relPath = absPath ? relPathFromRoot(root, absPath) : '';

  return (
    <>
      {absPath && anchor && (
        <Popover
          anchor={anchor}
          open
          onClose={onClose}
          role="menu"
          align={align}
          gap={gap}
          estimatedWidth={190}
          ariaLabel="File options"
        >
          <FileActionItems
            absPath={absPath}
            isPinned={pinned.includes(relPath)}
            onTogglePin={bindingId ? () => togglePin(relPath) : undefined}
            onRename={() => setRenamePath(absPath)}
            onArchive={() => void archiveEntry(root, rootId, relPath)}
            onDone={onClose}
          />
        </Popover>
      )}
      <RenameFileDialog
        open={renamePath !== null}
        onOpenChange={(open) => {
          if (!open) setRenamePath(null);
        }}
        absPath={renamePath ?? ''}
        root={root}
        rootId={rootId}
        currentName={renamePath?.split('/').pop() ?? ''}
        onRenamed={() => setRenamePath(null)}
      />
    </>
  );
}
