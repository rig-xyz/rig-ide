import { Archive, Copy, FolderOpen, Pencil, Pin } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { ContextMenuItem } from './row-context-menu';

/**
 * The file actions both the tree's row menu (`file-tree.tsx`) and a file's
 * title bar menu (`artifact/file-options-menu.tsx`) offer — one set of
 * handlers and one set of menu rows, so the two menus can never disagree
 * about what "Archive" or "Pin to top" does.
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
 * file vanish for one person and stay put for everyone else. Resolves true
 * once the entry has moved; failures are toasted here.
 */
export async function archiveEntry(rootId: string, relPath: string): Promise<boolean> {
  try {
    const result = await rpc.rig.files.archive({ rootId, relativePath: relPath });
    if (result.success) return true;
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
