import { MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { FileActionsMenu } from '@renderer/features/workspace/file-actions';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';

/**
 * The `⋯` beside a file's name in its title bar: the same actions as the
 * Files list's right-click (`workspace/file-actions.tsx`), for the file you
 * are looking at. Rename and Archive announce the move, and `App.tsx` moves
 * or closes the open tab, so the view never edits a path that is gone.
 */
export function FileOptionsButton({
  root,
  rootId,
  bindingId,
  absPath,
}: {
  root: string;
  rootId: string;
  /** Pin to top/Unpin only shows when the rig's binding is known. */
  bindingId?: string | null;
  absPath: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

      <FileActionsMenu
        root={root}
        rootId={rootId}
        bindingId={bindingId}
        absPath={open ? absPath : null}
        anchor={triggerRef}
        onClose={() => setOpen(false)}
        gap={6}
      />
    </>
  );
}
