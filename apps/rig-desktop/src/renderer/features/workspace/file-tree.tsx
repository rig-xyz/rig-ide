import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Pencil,
  Pin,
  Sparkles,
  Table,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  isFileUnseen,
  rigSeenStateChangedChannel,
  type SeenMap,
} from '@shared/rig/seen-state';
import { filterTree, searchTree, sortTree, type TreeViewContext } from '@shared/rig/tree-view';
import { RenameFileDialog } from './rename-file-dialog';
import { RowLabel } from './row-label';
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
/** One level of nested indent, matching a depth-1 file row's own `indent + 18`. */
const SKILL_ROW_PADDING = 8 + 14 + 18;

/**
 * The document's display name: its extracted title, else the full filename
 * (extension included — Dylan keeps extensions). Exported: `suggested-files.tsx`
 * needs the exact same title logic for card titles (design doc §3, "same
 * title logic as tree").
 */
export function displayTitle(node: RigFileNode): string {
  if (node.kind === 'dir') return node.name;
  return node.title ?? node.name;
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

/** Every `skills`-classified FILE, anywhere in the tree, flattened — folders that only contain skills are not themselves listed. */
function collectSkillFiles(nodes: RigFileNode[]): RigFileNode[] {
  const out: RigFileNode[] = [];
  const walk = (list: RigFileNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') {
        walk(node.children ?? []);
        continue;
      }
      if (classifyEntryCategory(node.relPath) === 'skills') out.push(node);
    }
  };
  walk(nodes);
  return out;
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
    if (category === 'skills') continue;
    if (category === 'system' && !showSystemFiles) continue;

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
  onUnseenCountChange,
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
  /** v2 round (§3.1): reports the CONTENT-ONLY unseen total (independent of `showSystemFiles`) up to the header's "N new" chip. */
  onUnseenCountChange?: (count: number) => void;
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

  const skillFiles = useMemo(() => collectSkillFiles(data ?? []), [data]);
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
  const menu = useRowContextMenu<MenuTarget>();
  const [renameTarget, setRenameTarget] = useState<RigFileNode | null>(null);

  if (isLoading) {
    return <p className="text-text-muted px-3 py-2 text-xs">Loading files…</p>;
  }
  if (error) {
    return (
      <p className="text-danger px-3 py-2 text-xs">
        {error instanceof Error ? error.message : 'Could not read this folder.'}
      </p>
    );
  }
  if (!data || data.length === 0) {
    if (justAttachedSyncing && !sawChange) {
      return (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
          <Loader2 className="text-text-muted size-4 animate-spin" strokeWidth={1.5} />
          <p className="text-text-muted text-xs">Syncing files…</p>
        </div>
      );
    }
    return <p className="text-text-muted px-3 py-2 text-xs">Empty folder.</p>;
  }

  if (contentTree.length === 0 && skillFiles.length === 0) {
    return <p className="text-text-muted px-3 py-2 text-xs">Empty folder.</p>;
  }

  const menuTarget = menu.state?.target ?? null;
  const menuTargetIsPinned = menuTarget !== null && pinned.includes(menuTarget.relPath);

  return (
    <>
      <div
        className="flex flex-col py-1"
        onContextMenu={(event) => {
          if (bindingId) menu.open(event, null);
        }}
      >
        {viewTree.map((node) => (
          <TreeNode
            key={node.relPath}
            node={node}
            depth={0}
            root={root}
            activePath={activePath}
            revealPath={revealPath ?? null}
            onOpenFile={handleOpenFile}
            onContextMenu={menu.open}
            unseenFiles={unseen.unseenFiles}
            unseenCountByDir={unseen.unseenCountByDir}
            pinned={pinned}
          />
        ))}
        <SkillsSection
          files={skillFiles}
          root={root}
          activePath={activePath}
          onOpenFile={handleOpenFile}
          onContextMenu={menu.open}
          seenState={seenState}
        />
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
  const open = manualOpen ?? (depth < 1 || isAncestorOfReveal || isRevealTarget);
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
            'rounded-control flex h-7 w-full items-center gap-1.5 pr-3 text-left text-sm transition-colors',
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
          <FolderGlyph className="size-3.5 shrink-0" strokeWidth={1.5} />
          <RowLabel text={node.name} className="flex-1" />
          {!!unseenCount && <span className="unseen-dot-in bg-accent size-[5px] shrink-0 rounded-full" />}
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
  return (
    <div
      onContextMenu={(event) => onContextMenu(event, node)}
      className={cn(
        'rounded-control flex h-7 w-full items-center text-sm transition-colors',
        active ? 'bg-bg-2 text-text-primary' : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <button
        type="button"
        onClick={() => onOpenFile(absPath, node.relPath)}
        style={{ paddingLeft: indent + 18 }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left"
      >
        <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <RowLabel text={displayTitle(node)} filename={node.name} className={cn(isUnseen && 'font-medium')} />
        {isUnseen && <span className="unseen-dot-in bg-accent size-[5px] shrink-0 rounded-full" />}
      </button>
      {node.mtimeMs !== undefined && (
        <span className="text-text-muted shrink-0 pr-2 text-xs tabular-nums">
          {relativeTime(node.mtimeMs, Date.now())}
        </span>
      )}
      {isPinned && (
        <Pin className="text-accent mr-2 size-3 shrink-0" strokeWidth={1.5} fill="currentColor" />
      )}
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
 * the shimmer-on-hover (`skill-label-shimmer`, defined in
 * `renderer/tokens.css`, itself gated behind `prefers-reduced-motion`) — a
 * gradient sweep through the type via `background-clip: text` — the app's
 * one deliberate decorative motion, reserved for skills so it stays
 * meaningful. v2 round: unchanged apart from the same tooltip-only-when-
 * truncated rule (§3.3) every other row now follows.
 */
function SkillsSection({
  files,
  root,
  activePath,
  onOpenFile,
  onContextMenu,
  seenState,
}: {
  files: RigFileNode[];
  root: string;
  activePath: string | null;
  onOpenFile: (absPath: string, relPath: string) => void;
  onContextMenu: (event: React.MouseEvent, node: RigFileNode) => void;
  /** File-navigator redesign (§4): same seen-state FileTree already fetched — null while it's still loading, or when there's no bindingId at all. */
  seenState: { baselineAt: number; seen: SeenMap } | null;
}) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;

  const sorted = [...files].sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
  const unseenCount = seenState
    ? sorted.filter((node) => isFileUnseen(node.mtimeMs, seenState.seen[node.relPath], seenState.baselineAt)).length
    : 0;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{ paddingLeft: 8 }}
        className="text-text-secondary hover:bg-bg-2 hover:text-text-primary flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" strokeWidth={1.5} />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" strokeWidth={1.5} />
        )}
        <Sparkles className="text-accent size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 truncate">Skills</span>
        {!!unseenCount && <span className="unseen-dot-in bg-accent size-[5px] shrink-0 rounded-full" />}
      </button>
      {open &&
        sorted.map((node) => {
          const absPath = `${root}/${node.relPath}`;
          const active = absPath === activePath;
          const isUnseen = seenState
            ? isFileUnseen(node.mtimeMs, seenState.seen[node.relPath], seenState.baselineAt)
            : false;
          return (
            <button
              key={node.relPath}
              type="button"
              onClick={() => onOpenFile(absPath, node.relPath)}
              onContextMenu={(event) => onContextMenu(event, node)}
              style={{ paddingLeft: SKILL_ROW_PADDING }}
              className={cn(
                'flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors',
                active
                  ? 'bg-bg-2 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
              )}
            >
              <Sparkles className="text-accent size-3.5 shrink-0" strokeWidth={1.5} />
              <RowLabel text={displayTitle(node)} filename={node.name} className="skill-label-shimmer" />
              {isUnseen && <span className="unseen-dot-in bg-accent size-[5px] shrink-0 rounded-full" />}
            </button>
          );
        })}
    </div>
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
