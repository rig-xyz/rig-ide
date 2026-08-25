import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDownAZ,
  EyeOff,
  ArrowUpDown,
  Check,
  CheckCheck,
  Clock,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileText,
  Folder,
  Flame,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  Table,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { classifyEntryCategory, filterToContentOnly } from '@shared/rig/file-navigator-categories';
import { rigFileChangeChannel } from '@shared/rig/files';
import type { RigFileNode } from '@shared/rig/files';
import {
  DEFAULT_FILE_TREE_VIEW,
  rigSettingsChangedChannel,
  type FileTreeFilter,
  type FileTreeSort,
} from '@shared/rig/settings';
import {
  collectFileRelPaths,
  computeUnseenSummary,
  rigSeenStateChangedChannel,
  type SeenMap,
} from '@shared/rig/seen-state';
import { filterTree, searchTree, sortTree, type TreeViewContext } from '@shared/rig/tree-view';
import { RenameFileDialog } from './rename-file-dialog';
import { RowLabel } from './row-label';
import { RowStatusPill, type RowStatus } from './row-status-pill';
import { useRecentWrites } from './write-activity';
import { ContextMenuItem, ContextMenuSeparator, RowContextMenu, useRowContextMenu } from './row-context-menu';

/**
 * Real filesystem tree for the opened rig, via `rpc.rig.files.list` — a small,
 * new main rpc (see `main/rig/files.ts`), not a port of emdash's file-tree
 * component: that one is wired through the emdash project/workspace registry
 * (`workspace.fileTree`, `FileTreeProjector`) this app doesn't carry (see the
 * P0 report). Recursive listing, folders collapsible, no colored left rail,
 * per the design system's hard rule.
 *
 * Round (live file tree): the listing used to be a one-shot fetch — an
 * agent creating a file was invisible here until something else (leaving
 * and reopening the workspace screen) happened to remount this component
 * and refetch. `main/rig/files.ts` already runs a real, debounced
 * `node:fs.watch(root, {recursive:true})` and emits `rigFileChangeChannel`
 * on every change — `doc-file-sync.ts`'s absorb path has used it from the
 * start, this component just never subscribed. Same pattern here:
 * `watch`/`unwatch` are refcounted per root, so this and any open doc tab
 * watching the same root share one real OS watcher.
 *
 * File-navigator redesign (`docs/file-navigator-design.md` §1): rows now
 * show the document's TITLE (`node.title`, extracted+cached in main —
 * `main/rig/file-title-cache.ts`) in the sans stack, falling back to the
 * full filename, extension included; the real filename lives in the row's
 * tooltip for when a title replaces it. Entries split into three categories
 * (`classifyEntryCategory`): Content renders as the normal tree below;
 * Skills (`.claude/skills`, `.agents/skills`, `.claude/commands`,
 * `AGENTS.md`/`CLAUDE.md` at any depth) are pulled out into one collapsed
 * "Skills" section at the bottom instead of being interleaved; System
 * (`rig.toml`, `.rig/`, other dotfiles/dot-dirs) stays hidden unless
 * `showSystemFiles` is on (`App.tsx`'s `FileBrowser` header toggle).
 * Sorting itself (folders first, then title A-Z) happens server-side in
 * `main/rig/files.ts`'s `listDir` — filtering here only ever REMOVES nodes,
 * never reorders what's left.
 *
 * v2 round (§3.3): row anatomy rebuilt onto a calmer Finder-style chassis —
 * 28px rows, full-row rounded hover, medium weight + a 5px accent dot for
 * unseen (never a naked count), right-aligned relative modified time for
 * files. All row-level ACTIONS (Open, Pin to top, Copy path, Reveal in
 * Finder, Rename, Mark (all) as seen) moved off hover buttons and into a
 * single right-click context menu (`row-context-menu.tsx`) shared by every
 * row and the tree's own root — no more per-row hover-pin button, no more
 * header "Mark all as seen" (that action now lives in the root's own
 * right-click menu). Tooltips (`row-label.tsx`) appear only when a row's
 * text is actually truncated or stands in for a different real filename —
 * never a native `title` attribute repeating the row's own visible text.
 */

const HIGHLIGHT_MS = 1400;

/** Sort names describe the resulting ORDER, not the machinery behind it. */
const FILE_SORT_LABELS: Record<FileTreeSort, string> = {
  smart: 'Activity',
  modified: 'Modified',
  name: 'Name',
};
const FILE_SORT_ICONS: Record<FileTreeSort, typeof Clock> = {
  smart: Flame,
  modified: Clock,
  name: ArrowDownAZ,
};

/**
 * The unseen mark: one dot, in a fixed-width gutter at the START of every
 * row, files and folders alike. A left gutter rather than the right meta
 * column because the dot then sits at the same x on every row regardless
 * of what else that row has to say, which is what makes a column of them
 * scannable — the way an unread column in a mail client works.
 *
 * Not accent-coloured TEXT and not bold: green type reads as a link or a
 * success state, and weight alone is too quiet to find. The gutter is
 * always reserved, so a row never shifts when its dot appears or clears.
 */
function UnseenMark({ show }: { show: boolean }) {
  return (
    <span className="flex w-2.5 shrink-0 justify-center">
      {show && <span className="unseen-dot-in bg-text-secondary size-[5px] rounded-full" />}
    </span>
  );
}

/**
 * A row's display name: ALWAYS the real filename, extension included. Files
 * in a rig are things agents write and reference by path and humans open in
 * other tools, so the filename is the identity, not a fallback for it. The
 * extracted document title is secondary (`rowTitleHint`, tooltip only).
 * Exported so every surface naming a file agrees.
 */
export function displayName(node: RigFileNode): string {
  return node.name;
}

/** The extracted document title, only when it says something the filename doesn't — the `RowLabel` tooltip's input. */
export function rowTitleHint(node: RigFileNode): string | undefined {
  if (node.kind === 'dir') return undefined;
  return node.title ?? undefined;
}

/** Content-row icon by extension — reverted to the tree's original lucide line icons (icon asset pass deferred, see the design doc). Exported for `suggested-files.tsx`'s card type icon, same vocabulary as the tree row it points at. */
export function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx' || ext === 'txt') return FileText;
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx') return Table;
  return File;
}

/** The listing's react-query key — shared with `suggested-files.tsx` so both read the SAME cached `rpc.rig.files.list(root)` result rather than issuing a second, redundant call. */
export function rigFilesQueryKey(root: string): readonly ['rig', 'files', 'list', string] {
  return ['rig', 'files', 'list', root];
}

/**
 * The normal content tree: Skills entries are always pulled out (they
 * render in their own section, see `collectSkillFiles`); System entries
 * are pruned unless `showSystemFiles`. A folder that only ever contained
 * now-pruned entries is dropped too — a container that exists solely to
 * hold hidden content is itself clutter — but a folder that was ALREADY
 * empty in the raw listing still shows as an empty folder, unchanged.
 */
function filterContentTree(nodes: RigFileNode[], showSystemFiles: boolean): RigFileNode[] {
  const out: RigFileNode[] = [];
  for (const node of nodes) {
    const category = classifyEntryCategory(node.relPath);
    // Skills used to get their own tab and shimmer. A flat list of
    // SKILL.md files told nobody anything useful, so the whole idea is
    // withdrawn rather than half-shipped: skill files are machinery like
    // everything else under a dot-folder, hidden unless you ask to see
    // system files. Worth revisiting only with a real design for what a
    // skill IS to a reader.
    if ((category === 'skills' || category === 'system') && !showSystemFiles) continue;

    if (node.kind === 'dir') {
      const originalChildren = node.children ?? [];
      const filteredChildren = filterContentTree(originalChildren, showSystemFiles);
      if (originalChildren.length > 0 && filteredChildren.length === 0) continue;
      out.push({ ...node, children: filteredChildren });
    } else {
      out.push(node);
    }
  }
  return out;
}

/** The row context menu's target: a real node, or `null` for the tree's own root (right-click on empty space). */
type MenuTarget = RigFileNode | null;

export function FileTree({
  root,
  bindingId = null,
  activePath,
  revealPath,
  onOpenFile,
  justAttachedSyncing = false,
  showSystemFiles = false,
  sort = DEFAULT_FILE_TREE_VIEW.sort,
  filter = DEFAULT_FILE_TREE_VIEW.filter,
  search = '',
  onChangeSort,
  onToggleShowSystemFiles,
  onUnseenCountChange,
  onProvideMarkAllSeen,
}: {
  root: string;
  /**
   * File-navigator redesign (§4, seen-state): identifies this rig for the
   * `rig_seen_files` table. Optional (and the whole seen-state feature
   * quietly no-ops without one) so the existing live-update tests, which
   * render `FileTree` with only `root`/`activePath`/`onOpenFile`, keep
   * passing unchanged — a real mount always has one (`App.tsx`'s `bound.bindingId`).
   */
  bindingId?: string | null;
  activePath: string | null;
  /**
   * A folder's relPath to expand its ancestors for, scroll into view, and
   * briefly highlight — set by a breadcrumb folder-segment click
   * (`App.tsx`'s `popToBrowser(relPath)`). One-shot: consumed by the
   * matching `TreeNode` the moment it mounts revealed.
   */
  revealPath?: string | null;
  onOpenFile: (absPath: string) => void;
  /**
   * First-sync round: true for the one root just downloaded via "Download"/
   * "Set up locally" (`rig attach --json`'s own `syncing` flag, handed
   * through `App.tsx`'s `openPath` via `lib/just-attached.ts`) — while
   * true AND the listing is still empty, the empty branch below reads as
   * "syncing files…" instead of "Empty folder." Investigated: no RPC in
   * this app reports "tapd is actively pulling right now" as an ongoing
   * status; the real signal used here instead is the SAME file-watcher
   * subscription this component already runs (`sawChange` below) — the
   * first `rigFileChangeChannel` event for this root means tapd either
   * produced files (the listing itself stops being empty) or settled
   * without any (a genuinely empty rig), and either way "syncing" has
   * stopped being the honest word for the state. A timer would guess at
   * that moment; this waits for real evidence of it instead.
   */
  justAttachedSyncing?: boolean;
  /** File-navigator redesign: System entries stay hidden until this is true (`App.tsx`'s `FileBrowser` header toggle). */
  showSystemFiles?: boolean;
  /** File-navigator redesign (§5, re-specced §3.4): the tree's own sort/filter choice (`App.tsx`'s header), per rig — defaults match `DEFAULT_FILE_TREE_VIEW` for the same reason `showSystemFiles` defaults `false`: existing tests mount `FileTree` without either. */
  sort?: FileTreeSort;
  filter?: FileTreeFilter;
  /** v2 round (§3.1): the header search field's live query — title + filename, case-insensitive substring (`searchTree`). */
  search?: string;
  /** v3: the sort control lives in the explorer's own tab strip, so changing it reports back up to whoever persists the choice. Omitted in tests, where the strip renders without it. */
  onChangeSort?: (sort: FileTreeSort) => void;
  /** v3: "Show system files" moved into the explorer's own view menu, beside sort. */
  onToggleShowSystemFiles?: () => void;
  /** v2 round (§3.1): reports the CONTENT-ONLY unseen total (independent of `showSystemFiles`) up to the header's "N new" chip. */
  onUnseenCountChange?: (count: number) => void;
  /** v3: hands the header's "N new" chip a way to clear everything, using the listing this component already has. */
  onProvideMarkAllSeen?: (fn: (() => void) | null) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => rigFilesQueryKey(root), [root]);
  const [sawChange, setSawChange] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await rpc.rig.files.list(root);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
  });

  // Live updates: refetch the listing whenever anything under `root`
  // changes on disk — an agent writing a file, `git checkout`, another
  // editor, all of it. `main/rig/files.ts` already debounces (200ms) and
  // ignores `.git`/`node_modules` before this ever fires, so no extra
  // debouncing needed here. Also flips `sawChange` — see
  // `justAttachedSyncing`'s own comment above.
  useEffect(() => {
    setSawChange(false);
    void rpc.rig.files.watch(root);
    const off = events.on(rigFileChangeChannel, ({ root: changedRoot }) => {
      if (changedRoot !== root) return;
      setSawChange(true);
      void queryClient.invalidateQueries({ queryKey });
    });
    return () => {
      off();
      void rpc.rig.files.unwatch(root);
    };
  }, [root, queryClient, queryKey]);

  const contentTree = useMemo(
    () => filterContentTree(data ?? [], showSystemFiles),
    [data, showSystemFiles]
  );

  // Seen-state (§4): baseline + last-viewed map for this rig, refetched on
  // bindingId change and whenever a mark-seen elsewhere (e.g. a context
  // menu's "Mark all as seen") broadcasts for the same bindingId. Quietly
  // does nothing without a bindingId — see the prop's own comment.
  const [seenState, setSeenState] = useState<{ baselineAt: number; seen: SeenMap } | null>(null);
  useEffect(() => {
    if (!bindingId) {
      setSeenState(null);
      return;
    }
    let alive = true;
    const load = () => {
      void rpc.rig.seenState.getState({ bindingId }).then((state) => {
        if (alive) setSeenState(state);
      });
    };
    load();
    const off = events.on(rigSeenStateChangedChannel, ({ bindingId: changed }) => {
      if (changed === bindingId) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId]);

  // Ghost-row sweep: once per bindingId, the first time a listing actually
  // loads — not on every live-update refetch (that would fire a DB write on
  // every debounced fs change, which the design doc explicitly wants cheap).
  const sweptForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bindingId || !data) return;
    if (sweptForRef.current === bindingId) return;
    sweptForRef.current = bindingId;
    void rpc.rig.seenState.sweep({ bindingId, existingRelPaths: collectFileRelPaths(data) });
  }, [bindingId, data]);

  const unseen = useMemo(
    () =>
      seenState
        ? computeUnseenSummary(contentTree, seenState.seen, seenState.baselineAt)
        : { unseenFiles: new Set<string>(), unseenCountByDir: {} },
    [contentTree, seenState]
  );

  // v2 round (§3.1/§3.2): the header's "N new" chip needs a CONTENT-ONLY
  // count, structurally independent of `showSystemFiles` — built off the
  // raw listing through `filterToContentOnly`, not `contentTree` (which
  // includes system entries once the toggle is on).
  const contentUnseenCount = useMemo(() => {
    if (!seenState || !data) return 0;
    return computeUnseenSummary(filterToContentOnly(data), seenState.seen, seenState.baselineAt).unseenFiles.size;
  }, [data, seenState]);
  useEffect(() => {
    onUnseenCountChange?.(contentUnseenCount);
  }, [contentUnseenCount, onUnseenCountChange]);

  // File-navigator redesign (§5): sort/filter applied AFTER the content/
  // system split above, per `tree-view.ts`'s own header comment — filter
  // what's shown, then order what's left. v2 round: search narrows first
  // (§3.1's live title+filename match), then the unseen chip's filter,
  // then sort — order doesn't change the result (both filters intersect),
  // just reads as one incremental narrowing pass.
  const viewTree = useMemo(() => {
    const ctx: TreeViewContext = {
      seen: seenState?.seen ?? {},
      unseenFiles: unseen.unseenFiles,
      now: Date.now(),
    };
    return sortTree(filterTree(searchTree(contentTree, search), filter, ctx), sort, ctx);
  }, [contentTree, search, filter, sort, seenState, unseen.unseenFiles]);

  const markSeen = (relPath: string) => {
    if (!bindingId) return;
    void rpc.rig.seenState.markSeen({ bindingId, relPath });
  };

  const markAllSeen = (relPaths: string[]) => {
    if (!bindingId) return;
    void rpc.rig.seenState.markAllSeen({ bindingId, relPaths });
  };

  useEffect(() => {
    if (!onProvideMarkAllSeen) return;
    if (!bindingId || !data) {
      onProvideMarkAllSeen(null);
      return;
    }
    const paths = collectFileRelPaths(data);
    // Wrapped in a thunk: `setState` treats a bare function argument as an
    // updater, so the callback has to arrive inside another function.
    onProvideMarkAllSeen(() => () => {
      void rpc.rig.seenState.markAllSeen({ bindingId, relPaths: paths });
    });
    return () => onProvideMarkAllSeen(null);
  }, [bindingId, data, onProvideMarkAllSeen]);

  const handleOpenFile = (absPath: string, relPath: string) => {
    markSeen(relPath);
    onOpenFile(absPath);
  };

  // Card rail round (§3), still true in v2: pin state, now consumed only by
  // the row context menu's "Pin to top"/"Unpin" and each row's static pin
  // glyph (no more per-row hover toggle button — see this file's own header
  // comment). Same fetch/subscribe shape as seen-state above; `suggested-files.tsx`
  // keeps its own independent copy of the same settings slice rather than
  // this being threaded down as a prop — small, duplicated effects over a
  // shared one is this app's own convention (see `useRevealHighlight`'s
  // header comment).
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

  const togglePin = (relPath: string) => {
    if (!bindingId) return;
    const next = pinned.includes(relPath) ? pinned.filter((p) => p !== relPath) : [...pinned, relPath];
    setPinned(next);
    void rpc.rig.settings.set({ pinnedPathsByRig: { [bindingId]: next } });
  };

  // v2 round (§3.3): the ONE row context menu, shared by every row and the
  // tree's own root (`target: null`) — right-clicking anywhere replaces the
  // old hover-button clutter and the header's own "Mark all as seen" row.
  // v3 keeps the right-click AND gives each row a visible `⋯` trigger that
  // opens the same menu: discoverable for anyone who never right-clicks,
  // one implementation either way.
  const menu = useRowContextMenu<MenuTarget>();
  const [renameTarget, setRenameTarget] = useState<RigFileNode | null>(null);

  // v3: the row status pill's live signal. Agent writes come from the
  // transcript-derived write log; "recent" is anything changed on disk
  // inside the window, deliberately unattributed (the watcher cannot tell
  // a human's editor from the sync daemon).
  const recentWrites = useRecentWrites(root);
  const agentPaths = useMemo(() => new Set(recentWrites.map((w) => w.relPath)), [recentWrites]);
  const statusFor = useCallback(
    (relPath: string): RowStatus | null => (agentPaths.has(relPath) ? { kind: 'agent' } : null),
    [agentPaths]
  );

  // The `⋯` button opens the shared menu at the button's own corner rather
  // than the pointer, so it behaves like every other dropdown in the app.
  const openRowMenu = useCallback(
    (event: React.MouseEvent, node: RigFileNode) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      menu.openAt({ x: rect.right - 4, y: rect.bottom + 2 }, node);
    },
    [menu]
  );

  const archive = (node: RigFileNode) => {
    void rpc.rig.files.archive(root, `${root}/${node.relPath}`);
  };

  /**
   * v3: the explorer's tab strip stays put through every state — a panel
   * whose chrome disappears while it loads and reappears after reads as two
   * different screens. Only the BODY swaps.
   */
  const tabs = (
    <ExplorerTabs
      sort={sort}
      onChangeSort={onChangeSort}
      showSystemFiles={showSystemFiles}
      onToggleShowSystemFiles={onToggleShowSystemFiles}
    />
  );

  if (isLoading) {
    return (
      <>
        {tabs}
        <p className="text-text-muted px-3 py-2 text-xs">Loading files…</p>
      </>
    );
  }
  if (error) {
    return (
      <>
        {tabs}
        <p className="text-danger px-3 py-2 text-xs">
          {error instanceof Error ? error.message : 'Could not read this folder.'}
        </p>
      </>
    );
  }
  if (!data || data.length === 0 || contentTree.length === 0) {
    if (justAttachedSyncing && !sawChange) {
      return (
        <>
          {tabs}
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <Loader2 className="text-text-muted size-4 animate-spin" strokeWidth={1.5} />
            <p className="text-text-muted text-xs">Syncing files…</p>
          </div>
        </>
      );
    }
    return (
      <>
        {tabs}
        <p className="text-text-muted px-3 py-2 text-xs">Empty folder.</p>
      </>
    );
  }

  const menuTarget = menu.state?.target ?? null;
  const menuTargetIsPinned = menuTarget !== null && pinned.includes(menuTarget.relPath);

  return (
    <>
      {tabs}
      <div
        className="@container flex flex-col py-1 pr-2"
        onContextMenu={(event) => {
          if (bindingId) menu.open(event, null);
        }}
      >
        {viewTree.length === 0 ? (
          <p className="text-text-muted px-3 py-6 text-center text-xs">
              {search ? `Nothing matching "${search}".` : 'Nothing here yet.'}
            </p>
          ) : (
            viewTree.map((node) => (
              <TreeNode
                key={node.relPath}
                node={node}
                depth={0}
                root={root}
                activePath={activePath}
                revealPath={revealPath ?? null}
                onOpenFile={handleOpenFile}
                onContextMenu={menu.open}
                onRowMenu={openRowMenu}
                statusFor={statusFor}
                forceOpen={search.trim().length > 0 || filter === 'unseen'}
                unseenFiles={unseen.unseenFiles}
                unseenCountByDir={unseen.unseenCountByDir}
                pinned={pinned}
              />
          ))
        )}
      </div>

      {menu.state &&
        (() => {
          const target = menu.state.target;
          const absPath = target ? `${root}/${target.relPath}` : null;
          return (
            <RowContextMenu point={menu.state.point} onClose={menu.close}>
              {target === null ? (
                <ContextMenuItem
                  label="Mark all as seen"
                  icon={CheckCheck}
                  onSelect={() => {
                    markAllSeen(collectFileRelPaths(data));
                    menu.close();
                  }}
                />
              ) : (
                <>
                  {target.kind === 'file' && (
                    <ContextMenuItem
                      label="Open"
                      icon={ExternalLink}
                      onSelect={() => {
                        handleOpenFile(absPath as string, target.relPath);
                        menu.close();
                      }}
                    />
                  )}
                  {target.kind === 'file' && (
                    <ContextMenuItem
                      label={menuTargetIsPinned ? 'Unpin' : 'Pin to top'}
                      icon={Pin}
                      onSelect={() => {
                        togglePin(target.relPath);
                        menu.close();
                      }}
                    />
                  )}
                  <ContextMenuItem
                    label="Copy path"
                    icon={Copy}
                    onSelect={() => {
                      void rpc.app.clipboardWriteText(absPath as string);
                      menu.close();
                    }}
                  />
                  <ContextMenuItem
                    label="Reveal in Finder"
                    icon={FolderOpen}
                    onSelect={() => {
                      void rpc.app.showItemInFolder(absPath as string);
                      menu.close();
                    }}
                  />
                  <ContextMenuItem
                    label="Rename"
                    icon={Pencil}
                    onSelect={() => {
                      setRenameTarget(target);
                      menu.close();
                    }}
                  />
                  {/*
                    Archive moves the entry into `_archive/` at the rig
                    root — a real move everyone sharing the rig can see,
                    not a private flag that would make a file vanish for
                    one person and stay put for everyone else.
                  */}
                  <ContextMenuItem
                    label="Archive"
                    icon={Archive}
                    onSelect={() => {
                      archive(target);
                      menu.close();
                    }}
                  />
                  <ContextMenuSeparator />
                  {target.kind === 'file' ? (
                    <ContextMenuItem
                      label="Mark as seen"
                      icon={Check}
                      onSelect={() => {
                        markSeen(target.relPath);
                        menu.close();
                      }}
                    />
                  ) : (
                    <ContextMenuItem
                      label="Mark all seen"
                      icon={CheckCheck}
                      onSelect={() => {
                        markAllSeen(collectFileRelPaths(target.children ?? []));
                        menu.close();
                      }}
                    />
                  )}
                </>
              )}
            </RowContextMenu>
          );
        })()}

      {renameTarget && (
        <RenameFileDialog
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          absPath={`${root}/${renameTarget.relPath}`}
          currentName={renameTarget.name}
          onRenamed={() => setRenameTarget(null)}
        />
      )}
    </>
  );
}

function TreeNode({
  node,
  depth,
  root,
  activePath,
  revealPath,
  onOpenFile,
  onContextMenu,
  onRowMenu,
  statusFor,
  forceOpen,
  unseenFiles,
  unseenCountByDir,
  pinned,
}: {
  node: RigFileNode;
  depth: number;
  root: string;
  activePath: string | null;
  revealPath: string | null;
  onOpenFile: (absPath: string, relPath: string) => void;
  /** v2 round (§3.3): right-click anywhere on a row opens the shared context menu with THIS node as its target. */
  onContextMenu: (event: React.MouseEvent, node: RigFileNode) => void;
  /** v3: the row's own hover `⋯` button opens the SAME menu, positioned at the button instead of the cursor. */
  onRowMenu: (event: React.MouseEvent, node: RigFileNode) => void;
  /** v3: this file's status pill, or null when nothing is happening to it. */
  statusFor: (relPath: string) => RowStatus | null;
  /** v3: while a search is active every folder renders open, so a match is never hidden inside a collapsed parent. */
  forceOpen: boolean;
  /** File-navigator redesign (§4): every unseen FILE's relPath, for the row dot. */
  unseenFiles: Set<string>;
  /** Every DIR relPath with at least one unseen descendant, mapped to that count — v2 round: only the COUNT>0 presence is used now (a dot, never the number itself). */
  unseenCountByDir: Record<string, number>;
  /** Currently-pinned relPaths, for a file row's static pin glyph. */
  pinned: string[];
}) {
  // `null` = no explicit user choice yet, fall back to the default
  // (top-level open, or forced open while it's an ancestor of the reveal
  // target). A manual toggle always wins after that, including over a
  // still-pending reveal.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const absPath = `${root}/${node.relPath}`;
  const indent = 8 + depth * 14;

  // Computed for every node (not just dirs) so the two hooks below are
  // called unconditionally, in the same order, on every render — a file
  // node is simply never a reveal target (breadcrumb folder segments only
  // ever name directories), so this is always false for it.
  const isAncestorOfReveal =
    node.kind === 'dir' && revealPath !== null && revealPath.startsWith(`${node.relPath}/`);
  const isRevealTarget = revealPath !== null && revealPath === node.relPath;
  const open = forceOpen || (manualOpen ?? (depth < 1 || isAncestorOfReveal || isRevealTarget));
  const { ref: rowRef, flashing } = useRevealHighlight(isRevealTarget);

  if (node.kind === 'dir') {
    const FolderGlyph = open ? FolderOpen : Folder;
    const unseenCount = unseenCountByDir[node.relPath];

    return (
      <div>
        <button
          ref={rowRef}
          type="button"
          onClick={() => setManualOpen(!open)}
          onContextMenu={(event) => onContextMenu(event, node)}
          style={{ paddingLeft: indent }}
          className={cn(
            'rounded-control flex h-7 w-full items-center gap-1.5 pr-2 text-left text-sm transition-colors',
            flashing
              ? 'bg-accent-subtle text-text-primary'
              : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
          )}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" strokeWidth={1.5} />
          )}
          <UnseenMark show={!open && !!unseenCount} />
          <FolderGlyph className="size-3.5 shrink-0" strokeWidth={1.5} />
          <RowLabel text={displayName(node)} className="flex-1" />
          <span className="w-14 shrink-0" />
        </button>
        {open &&
          (node.children ?? []).map((child) => (
            <TreeNode
              key={child.relPath}
              node={child}
              depth={depth + 1}
              root={root}
              activePath={activePath}
              revealPath={revealPath}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              onRowMenu={onRowMenu}
              statusFor={statusFor}
              forceOpen={forceOpen}
              unseenFiles={unseenFiles}
              unseenCountByDir={unseenCountByDir}
              pinned={pinned}
            />
          ))}
      </div>
    );
  }

  const active = absPath === activePath;
  const Icon = iconFor(node.name);
  const isUnseen = unseenFiles.has(node.relPath);
  const isPinned = pinned.includes(node.relPath);
  const status = statusFor(node.relPath);
  return (
    <div
      onContextMenu={(event) => onContextMenu(event, node)}
      className={cn(
        'rounded-control group flex h-7 w-full items-center text-sm transition-colors',
        active ? 'bg-bg-2 text-text-primary' : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <button
        type="button"
        onClick={() => onOpenFile(absPath, node.relPath)}
        style={{ paddingLeft: indent + 18 }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left"
      >
        <UnseenMark show={isUnseen} />
        <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <RowLabel text={displayName(node)} title={rowTitleHint(node)} className={cn(status && 'active-shimmer')} />
      </button>
      {status && <RowStatusPill status={status} className="mr-2" />}
      {/*
        One fixed-width meta column, right-aligned, on EVERY row — files
        put their time here, folders their unseen mark, and because the
        width never changes the whole tree lines up in a single column
        instead of each row placing its own status wherever it happened to
        land. Unseen needs no badge of its own: a medium-weight name and an
        accent timestamp say it, the way an unread mail row does.
      */}
      <span className="text-text-muted w-14 shrink-0 pr-1 text-right text-xs tabular-nums group-hover:hidden">
        {node.mtimeMs === undefined ? '' : relativeTime(node.mtimeMs, Date.now())}
      </span>
      {isPinned && (
        <Pin className="text-text-muted mr-1 size-3 shrink-0 group-hover:hidden" strokeWidth={1.5} fill="currentColor" />
      )}
      <button
        type="button"
        aria-label="File actions"
        onClick={(event) => {
          event.stopPropagation();
          onRowMenu(event, node);
        }}
        className="rounded-control text-text-muted hover:bg-bg-1 hover:text-text-primary mr-2 hidden size-5 shrink-0 items-center justify-center group-hover:flex focus-visible:flex"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}

/**
 * Skills, grouped into one section at the bottom, collapsed by default
 * (`docs/file-navigator-design.md` §1) — flat and sorted by title A-Z
 * rather than mirroring their original folder structure: the design doc
 * asks for "a single Skills section," not a second parallel tree, and a
 * flat list keeps that section legible even when skills live at different
 * depths (`.claude/skills/<name>/SKILL.md`, a top-level `AGENTS.md`, a
 * `.claude/commands/*.md`). Each row's LABEL TEXT (not the row itself) gets
 * the live-write shimmer (`active-shimmer`, defined in
 * `renderer/tokens.css`, itself gated behind `prefers-reduced-motion`) — a
 * gradient sweep through the type via `background-clip: text` — the app's
 * one deliberate decorative motion, reserved for skills so it stays
 * meaningful. v2 round: unchanged apart from the same tooltip-only-when-
 * truncated rule (§3.3) every other row now follows.
 */
/**
 * The explorer's own chrome: which view of the rig you are looking at, and
 * how it is ordered. Tabs rather than a filter menu because "all files" and
 * "skills" are different KINDS of thing, not two filters over one list —
 * skills are capability, files are content, and a tab strip says that
 * without a word of explanation. Sort sits at the far right of the same
 * row, labelled with its current value the way Finder's own sort control
 * is, so nothing about the current view is hidden inside a popover.
 */
function ExplorerTabs({
  sort,
  onChangeSort,
  showSystemFiles,
  onToggleShowSystemFiles,
}: {
  sort: FileTreeSort;
  onChangeSort?: (sort: FileTreeSort) => void;
  showSystemFiles: boolean;
  /** v3: "Show system files" moved into the explorer's own view menu, beside sort. */
  onToggleShowSystemFiles?: () => void;
}) {
  return (
    <div className="border-border-hairline flex h-10 shrink-0 items-center gap-1 border-b px-3">
      <div className="flex-1" />
      {onChangeSort && (
        <SortControl
          sort={sort}
          onChangeSort={onChangeSort}
          showSystemFiles={showSystemFiles}
          onToggleShowSystemFiles={onToggleShowSystemFiles}
        />
      )}
    </div>
  );
}

/**
 * Sort, named by what it actually does to the list rather than by how
 * clever it is: "Activity" puts what is being worked on at the top,
 * "Modified" is plain recency, "Name" is A to Z. The trigger always shows
 * the current value.
 */
function SortControl({
  sort,
  onChangeSort,
  showSystemFiles,
  onToggleShowSystemFiles,
}: {
  sort: FileTreeSort;
  onChangeSort: (sort: FileTreeSort) => void;
  /** Finder keeps "show hidden" in the same View menu as sort: both answer "what am I looking at", neither is an action on a file. */
  showSystemFiles: boolean;
  onToggleShowSystemFiles?: () => void;
}) {
  const menu = useRowContextMenu<null>();
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          menu.openAt({ x: rect.right, y: rect.bottom + 2 }, null);
        }}
        className="rounded-control text-text-muted hover:bg-bg-2 hover:text-text-primary flex shrink-0 items-center gap-1 px-1.5 py-1 text-xs transition-colors"
      >
        <ArrowUpDown className="size-3 shrink-0" strokeWidth={1.5} />
        {FILE_SORT_LABELS[sort]}
      </button>
      {menu.state && (
        <RowContextMenu point={menu.state.point} onClose={menu.close}>
          {(['smart', 'modified', 'name'] as const).map((option) => (
            <ContextMenuItem
              key={option}
              label={FILE_SORT_LABELS[option]}
              icon={sort === option ? Check : FILE_SORT_ICONS[option]}
              onSelect={() => {
                onChangeSort(option);
                menu.close();
              }}
            />
          ))}
          {onToggleShowSystemFiles && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                label="Show system files"
                icon={showSystemFiles ? Check : EyeOff}
                onSelect={() => {
                  onToggleShowSystemFiles();
                  menu.close();
                }}
              />
            </>
          )}
        </RowContextMenu>
      )}
    </>
  );
}

/**
 * Scrolls a just-revealed row into view once and flags it for a brief
 * highlight — the "targeted navigation" half of a breadcrumb folder click,
 * paired with the ancestor-forced-open above.
 */
function useRevealHighlight(isTarget: boolean): {
  ref: React.RefObject<HTMLButtonElement | null>;
  flashing: boolean;
} {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!isTarget) return;
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
    // Fires once per reveal — `isTarget` flips true only when this exact
    // node becomes the target of a fresh breadcrumb click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTarget]);

  return { ref, flashing };
}
