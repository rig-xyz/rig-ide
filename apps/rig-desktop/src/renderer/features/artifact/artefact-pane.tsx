import { FolderTree, Plus, Rows3, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { iconFor } from '@renderer/features/workspace/file-tree';
import { Popover, PopoverMenuItem } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { type ArtefactTabsState } from './artefact-tabs';
import { ArtifactView } from './artifact-view';
import { FocusView } from './focus-view';
import { NavigatorPopover } from './navigator-popover';

/**
 * Session-first viewer: the artefact pane — the right half of the split,
 * which exists only while it has tabs (`App.tsx` collapses the split
 * entirely at zero). One tab per open file plus at most one focus view;
 * the (+) carries the choice between them, and "Open file…" drops the
 * navigator popover (the tree's new home). Same tab grammar as the chat
 * panel's session strip — bg-2 + text shift marks active, close on hover,
 * no colored rails.
 */

export function ArtefactPane({
  root,
  rootId,
  bindingId,
  state,
  onActivateTab,
  onCloseTab,
  onOpenFile,
  onOpenFocus,
}: {
  root: string;
  rootId: string;
  bindingId: string;
  state: ArtefactTabsState;
  onActivateTab: (index: number) => void;
  onCloseTab: (index: number) => void;
  /** Opens (or re-activates) an editor tab; relPath rides along for seen-state. */
  onOpenFile: (absPath: string, relPath: string) => void;
  onOpenFocus: () => void;
}) {
  const plusRef = useRef<HTMLButtonElement>(null);
  const filesRef = useRef<HTMLButtonElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // Which anchor the navigator hangs off: the (+) menu's "Open file…" or
  // the active editor tab's Files button. One popover, two doors.
  const [navigator, setNavigator] = useState<'plus' | 'files' | null>(null);
  const [revealDir, setRevealDir] = useState<string | null>(null);

  const active = state.tabs[state.active] ?? null;

  const openNavigator = (anchor: 'plus' | 'files', dir: string | null = null) => {
    setRevealDir(dir);
    setNavigator(anchor);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-border-hairline flex h-10 shrink-0 items-center border-b">
        <div
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]"
        >
          {state.tabs.map((tab, index) => {
            if (tab.kind === 'focus') {
              return (
                <PaneTab
                  key="focus"
                  active={index === state.active}
                  onSelect={() => onActivateTab(index)}
                  onClose={() => onCloseTab(index)}
                >
                  <Rows3 className="size-3 shrink-0 text-text-muted" strokeWidth={1.5} />
                  <span>Focus</span>
                </PaneTab>
              );
            }
            const name = tab.path.split('/').pop() ?? tab.path;
            const Icon = iconFor(name);
            return (
              <PaneTab
                key={tab.path}
                active={index === state.active}
                onSelect={() => onActivateTab(index)}
                onClose={() => onCloseTab(index)}
              >
                <Icon className="size-3 shrink-0 text-text-muted" strokeWidth={1.5} />
                <span className="max-w-32 truncate">{name}</span>
              </PaneTab>
            );
          })}
        </div>
        <div className="border-border-hairline flex shrink-0 items-center border-l px-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={plusRef}
                  type="button"
                  onClick={() => setPlusOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={plusOpen}
                  aria-label="New tab"
                  className="hover:bg-bg-2 hover:text-text-primary flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
                >
                  <Plus className="size-3.5" strokeWidth={1.5} />
                </button>
              }
            />
            <TooltipContent side="bottom">New tab</TooltipContent>
          </Tooltip>
          <Popover
            anchor={plusRef}
            open={plusOpen}
            onClose={() => setPlusOpen(false)}
            role="menu"
            align="right"
            gap={4}
            estimatedWidth={190}
            minWidth={190}
          >
            <PopoverMenuItem
              icon={FolderTree}
              label="Open file…"
              onSelect={() => {
                setPlusOpen(false);
                openNavigator('plus');
              }}
            />
            <PopoverMenuItem
              icon={Rows3}
              label="Focus view"
              onSelect={() => {
                setPlusOpen(false);
                onOpenFocus();
              }}
            />
          </Popover>
        </div>
      </div>

      <NavigatorPopover
        root={root}
        rootId={rootId}
        anchor={navigator === 'files' ? filesRef : plusRef}
        open={navigator !== null}
        onClose={() => setNavigator(null)}
        onOpenFile={onOpenFile}
        revealDir={revealDir}
      />

      <div className="min-h-0 flex-1">
        {active === null ? null : active.kind === 'focus' ? (
          <FocusView root={root} rootId={rootId} bindingId={bindingId} />
        ) : (
          <ArtifactView
            key={active.path}
            root={root}
            rootId={rootId}
            path={active.path}
            onClose={() => onCloseTab(state.active)}
            onNavigateFolder={(relPath) => openNavigator('files', relPath)}
            leading={
              <button
                ref={filesRef}
                type="button"
                onClick={() => openNavigator('files')}
                aria-haspopup="dialog"
                aria-expanded={navigator === 'files'}
                className="border-border-hairline hover:bg-bg-2 hover:text-text-primary flex shrink-0 items-center gap-1 rounded-control border bg-transparent px-2 py-1 text-xs text-text-secondary transition-colors"
              >
                <FolderTree className="size-3.5" strokeWidth={1.5} />
                Files
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

/** Same visual grammar as the chat panel's session tabs — one look for "a tab" everywhere. */
function PaneTab({
  active,
  onSelect,
  onClose,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        'group flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-xs transition-colors',
        active
          ? 'bg-bg-2 text-text-primary'
          : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-1.5">
        {children}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close tab"
        title="Close tab"
        className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-primary"
      >
        <X className="size-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}
