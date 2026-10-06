import { useQuery } from '@tanstack/react-query';
import { Archive, Copy, FolderOpen, GitMerge, Pencil, Pin } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushOpenDocs } from '@renderer/features/docs/doc-file-sync';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { Popover, type PopoverAnchor } from '@renderer/lib/ui/popover';
import { groupConflictCopies } from '@shared/rig/conflict-copies';
import { relPathFromRoot } from '@shared/rig/file-navigator-categories';
import type { RigFileNode } from '@shared/rig/files';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { announceFileMove } from './file-moves';
import { rigFilesQueryKey } from './file-tree';
import { requestOpenFile } from './open-file-request';
import { RenameFileDialog } from './rename-file-dialog';
import { ContextMenuItem, ContextMenuSeparator } from './row-context-menu';

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

/** One of a file's conflict copies (`shared/rig/conflict-copies.ts`), with when it was written. */
export type ConflictCopy = { relPath: string; mtimeMs: number | null };

/**
 * The conflict copies kept beside `relPath`, newest first, from the same
 * cached listing the Files list reads. Empty for a file with none.
 */
export function useConflictCopies(root: string, rootId: string, relPath: string | null): ConflictCopy[] {
  const { data } = useQuery({
    queryKey: rigFilesQueryKey(root, rootId),
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    enabled: relPath !== null,
  });
  return useMemo(() => {
    if (!relPath || !data) return [];
    const mtimes = new Map<string, number | null>();
    const walk = (nodes: readonly RigFileNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'dir') walk(node.children ?? []);
        else mtimes.set(node.relPath, node.mtimeMs ?? null);
      }
    };
    walk(data);
    const copies = groupConflictCopies([...mtimes.keys()]).copiesByOriginal.get(relPath) ?? [];
    return copies
      .map((copy) => ({ relPath: copy, mtimeMs: mtimes.get(copy) ?? null }))
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }, [data, relPath]);
}

/** "Version from Oct 2, 4:12 PM", after when the copy was written. */
export function conflictCopyLabel(mtimeMs: number | null): string {
  if (mtimeMs === null) return 'An earlier version';
  const when = new Date(mtimeMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Version from ${when}`;
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
  // A clash this computer lost leaves its edit beside the file: each copy opens in a tab.
  const copies = useConflictCopies(root, rootId, absPath ? relPath : null);

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
          {copies.length > 0 && (
            <>
              <ContextMenuSeparator />
              <div className="px-2.5 pt-1 pb-0.5 text-2xs text-text-muted">Your other versions</div>
              {copies.map((copy) => (
                <ContextMenuItem
                  key={copy.relPath}
                  label={conflictCopyLabel(copy.mtimeMs)}
                  icon={GitMerge}
                  onSelect={() => {
                    requestOpenFile(`${root}/${copy.relPath}`);
                    onClose();
                  }}
                />
              ))}
            </>
          )}
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
