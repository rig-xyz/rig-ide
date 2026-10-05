import { MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  archiveEntry,
  FileActionItems,
  usePinnedPaths,
} from '@renderer/features/workspace/file-actions';
import { RenameFileDialog } from '@renderer/features/workspace/rename-file-dialog';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { relPathFromRoot } from '@shared/rig/file-navigator-categories';

/**
 * The `⋯` beside a file's name in its title bar: the same actions as the
 * tree's row menu (`workspace/file-actions.tsx`), for the file you are
 * looking at. Rename and Archive move the file, so the host is told where
 * it went (`onRenamed`) or that it is gone (`onArchived`) and the open
 * view follows instead of editing a path that no longer exists.
 */
export function FileOptionsButton({
  root,
  rootId,
  bindingId,
  absPath,
  beforeMove,
  onRenamed,
  onArchived,
}: {
  root: string;
  rootId: string;
  /** Pin to top/Unpin only shows when the rig's binding is known. */
  bindingId?: string | null;
  absPath: string;
  /** Settles anything unsaved before the file moves (an editable pane's pending autosave). */
  beforeMove?: () => Promise<void>;
  onRenamed: (newAbsPath: string) => void;
  onArchived: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const relPath = relPathFromRoot(root, absPath);
  const { pinned, togglePin } = usePinnedPaths(bindingId);

  const archive = async () => {
    await beforeMove?.();
    if (await archiveEntry(rootId, relPath)) onArchived();
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="File options"
              className={cn(
                'text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex size-6 shrink-0 items-center justify-center transition-colors',
                open && 'bg-bg-2 text-text-primary'
              )}
            >
              <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
            </button>
          }
        />
        <TooltipContent side="bottom">More</TooltipContent>
      </Tooltip>

      <Popover
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        align="left"
        gap={6}
        estimatedWidth={190}
        ariaLabel="File options"
      >
        <FileActionItems
          absPath={absPath}
          isPinned={pinned.includes(relPath)}
          onTogglePin={bindingId ? () => togglePin(relPath) : undefined}
          onRename={() => {
            void beforeMove?.();
            setRenaming(true);
          }}
          onArchive={() => void archive()}
          onDone={() => setOpen(false)}
        />
      </Popover>

      <RenameFileDialog
        open={renaming}
        onOpenChange={setRenaming}
        absPath={absPath}
        root={root}
        rootId={rootId}
        currentName={absPath.split('/').pop() ?? absPath}
        onRenamed={(newRelPath) => onRenamed(`${root}/${newRelPath}`)}
      />
    </>
  );
}
