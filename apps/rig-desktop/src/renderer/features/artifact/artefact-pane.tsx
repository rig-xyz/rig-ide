import { FolderTree, Plus, Rows3, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
 *
 * The (+) sits INLINE after the last tab (browser convention — the eye
 * adds a tab where tabs end) until the strip overflows, at which point it
 * retreats to the pinned right cluster so it can never scroll out of
 * reach. Tabs drag-reorder (HTML5 DnD, live reorder on drag-over).
 */

export function ArtefactPane({
  root,
  rootId,
  bindingId,
  state,
  onActivateTab,
  onCloseTab,
  onMoveTab,
  onOpenFile,
  onOpenFocus,
}: {
  root: string;
  rootId: string;
  bindingId: string;
  state: ArtefactTabsState;
  onActivateTab: (index: number) => void;
  onCloseTab: (index: number) => void;
  onMoveTab: (from: number, to: number) => void;
  /** Opens (or re-activates) an editor tab; relPath rides along for seen-state. */
  onOpenFile: (absPath: string, relPath: string) => void;
  onOpenFocus: () => void;
}) {
  const plusRef = useRef<HTMLButtonElement>(null);
  const filesRef = useRef<HTMLButtonElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // Which anchor the navigator hangs off: the (+) menu's "Open file…" or
  // the active editor tab's Files button. One popover, two doors.
  const [navigator, setNavigator] = useState<'plus' | 'files' | null>(null);
  const [revealDir, setRevealDir] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Inline (+) until the strip genuinely overflows — measured, not guessed.
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = tablistRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.tabs.length]);

  const active = state.tabs[state.active] ?? null;

  const openNavigator = (anchor: 'plus' | 'files', dir: string | null = null) => {
    setRevealDir(dir);
    setNavigator(anchor);
  };

  const plusButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={plusRef}
            type="button"
            onClick={() => {
              setNavigator(null);
              setPlusOpen((v) => !v);
            }}
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            aria-label="New tab"
            className="hover:bg-bg-2 hover:text-text-primary flex size-6 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors"
          >
            <Plus className="size-3.5" strokeWidth={1.5} />
          </button>
        }
      />
      <TooltipContent side="bottom">New tab</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="pane-in flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-border-hairline flex h-10 shrink-0 items-center border-b">
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Open files"
          // Roving arrows across the strip — the same traversal every menu
          // already has, so tabs aren't a mouse-only surface.
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = (state.active + delta + state.tabs.length) % state.tabs.length;
            onActivateTab(next);
            const buttons = tablistRef.current?.querySelectorAll<HTMLElement>('[data-pane-tab]');
            buttons?.[next]?.focus();
          }}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]"
        >
          {state.tabs.map((tab, index) => {
            const isFocus = tab.kind === 'focus';
            const name = isFocus ? 'Focus' : (tab.path.split('/').pop() ?? tab.path);
            const Icon = isFocus ? Rows3 : iconFor(name);
            // Two `notes.md` from different folders are identical chips —
            // disambiguate duplicates with the parent folder (VS Code rule).
            const duplicate =
              !isFocus &&
              state.tabs.some(
                (other) =>
                  other !== tab && other.kind === 'file' && other.path.split('/').pop() === name
              );
            const parent = isFocus ? null : (tab.path.split('/').slice(-2, -1)[0] ?? null);
            return (
              <PaneTab
                key={isFocus ? 'focus' : tab.path}
                active={index === state.active}
                dragging={dragIndex === index}
                title={isFocus ? undefined : tab.path}
                onSelect={() => onActivateTab(index)}
                onClose={() => onCloseTab(index)}
                onDragStart={() => setDragIndex(index)}
                onDragOverTab={() => {
                  if (dragIndex === null || dragIndex === index) return;
                  onMoveTab(dragIndex, index);
                  setDragIndex(index);
                }}
                onDragEnd={() => setDragIndex(null)}
              >
                <Icon className="size-3 shrink-0 text-text-muted" strokeWidth={1.5} />
                <span className="max-w-32 truncate">{name}</span>
                {duplicate && parent && (
                  <span className="max-w-20 truncate text-2xs text-text-muted">{parent}</span>
                )}
              </PaneTab>
            );
          })}
          {!overflowing && plusButton}
        </div>
        <div className="border-border-hairline flex shrink-0 items-center gap-0.5 border-l px-1.5">
          {overflowing && plusButton}
          {/* Feedback round 5: the navigator's door lives at TAB level, not
              on each file's header — it opens files, so it belongs with the
              tabs they open into, and the focus tab gets it for free. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={filesRef}
                  type="button"
                  // A control that opens a surface closes it too — toggle,
                  // never re-open.
                  onClick={() =>
                    navigator === 'files' ? setNavigator(null) : openNavigator('files')
                  }
                  aria-haspopup="dialog"
                  aria-expanded={navigator === 'files'}
                  aria-label="Files"
                  className="hover:bg-bg-2 hover:text-text-primary flex size-6 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors"
                >
                  <FolderTree className="size-3.5" strokeWidth={1.5} />
                </button>
              }
            />
            <TooltipContent side="bottom">Files</TooltipContent>
          </Tooltip>
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
        align="right"
      />

      <div className="min-h-0 flex-1">
        {active === null ? null : active.kind === 'focus' ? (
          <FocusView root={root} rootId={rootId} bindingId={bindingId} onOpenFile={onOpenFile} />
        ) : (
          <ArtifactView
            key={active.path}
            root={root}
            rootId={rootId}
            path={active.path}
            onNavigateFolder={(relPath) => openNavigator('files', relPath)}
          />
        )}
      </div>

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
  );
}

/** Same visual grammar as the chat panel's session tabs — one look for "a tab" everywhere. */
function PaneTab({
  active,
  dragging,
  title,
  onSelect,
  onClose,
  onDragStart,
  onDragOverTab,
  onDragEnd,
  children,
}: {
  active: boolean;
  dragging: boolean;
  /** Full path — real names truncate at max-w-32, the tooltip disambiguates. */
  title?: string;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragOverTab: () => void;
  onDragEnd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOverTab();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-xs transition-colors',
        active
          ? 'bg-bg-2 text-text-primary'
          : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary',
        dragging && 'opacity-50'
      )}
    >
      {/* The BUTTON carries the tab role — the wrapper is drag chrome. */}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-pane-tab
        tabIndex={active ? 0 : -1}
        title={title}
        onClick={onSelect}
        className="flex min-w-0 items-center gap-1.5 outline-none"
      >
        {children}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close tab"
        title="Close tab"
        className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100 group-focus-within:opacity-100"
      >
        <X className="size-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}
