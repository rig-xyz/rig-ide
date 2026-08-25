import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Pin,
  Sparkles,
  Table,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { classifyEntryCategory } from '@shared/rig/file-navigator-categories';
import { rigFileChangeChannel } from '@shared/rig/files';
import type { RigFileNode } from '@shared/rig/files';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import {
  collectFileRelPaths,
  computeUnseenSummary,
  isFileUnseen,
  rigSeenStateChangedChannel,
  type SeenMap,
} from '@shared/rig/seen-state';

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
 */

const HIGHLIGHT_MS = 1400;
/** One level of nested indent, matching a depth-1 file row's own `indent + 18`. */
const SKILL_ROW_PADDING = 8 + 14 + 18;

/**
 * The document's display name: its extracted title, else the full filename
 * (extension included — Dylan keeps extensions). Exported: `card-rail.tsx`
 * needs the exact same title logic for card titles (design doc §3, "same
 * title logic as tree").
 */
export function displayTitle(node: RigFileNode): string {
  if (node.kind === 'dir') return node.name;
  return node.title ?? node.name;
}

/** Content-row icon by extension — reverted to the tree's original lucide line icons (icon asset pass deferred, see the design doc). Exported for `card-rail.tsx`'s card type icon, same vocabulary as the tree row it points at. */
export function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx' || ext === 'txt') return FileText;
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx') return Table;
  return File;
}

/** The listing's react-query key — shared with `card-rail.tsx` so both read the SAME cached `rpc.rig.files.list(root)` result rather than issuing a second, redundant call. */
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

export function FileTree({
  root,
  bindingId = null,
  activePath,
  revealPath,
  onOpenFile,
  justAttachedSyncing = false,
  showSystemFiles = false,
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
  // bindingId change and whenever a mark-seen elsewhere (e.g. "Mark all as
  // seen" in `FileBrowserOptionsMenu`) broadcasts for the same bindingId.
  // Quietly does nothing without a bindingId — see the prop's own comment.
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

  const markSeen = (relPath: string) => {
    if (!bindingId) return;
    void rpc.rig.seenState.markSeen({ bindingId, relPath });
  };

  const handleOpenFile = (absPath: string, relPath: string) => {
    markSeen(relPath);
    onOpenFile(absPath);
  };

  // Card rail round (§3): pin state, so a file row can carry its own pin
  // toggle (design doc: "a small pin action on hover" — investigated, rows
  // have no context menu to hang this off instead). Same fetch/subscribe
  // shape as seen-state above; `card-rail.tsx` keeps its own independent
  // copy of the same settings slice rather than this being threaded down
  // as a prop — small, duplicated effects over a shared one is this app's
  // own convention (see `useRevealHighlight`'s header comment).
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

  return (
    <div className="flex flex-col py-1">
      {contentTree.map((node) => (
        <TreeNode
          key={node.relPath}
          node={node}
          depth={0}
          root={root}
          activePath={activePath}
          revealPath={revealPath ?? null}
          onOpenFile={handleOpenFile}
          unseenFiles={unseen.unseenFiles}
          unseenCountByDir={unseen.unseenCountByDir}
          pinned={pinned}
          onTogglePin={togglePin}
        />
      ))}
      <SkillsSection
        files={skillFiles}
        root={root}
        activePath={activePath}
        onOpenFile={handleOpenFile}
        seenState={seenState}
      />
    </div>
  );
}

function TreeNode({
  node,
  depth,
  root,
  activePath,
  revealPath,
  onOpenFile,
  unseenFiles,
  unseenCountByDir,
  pinned,
  onTogglePin,
}: {
  node: RigFileNode;
  depth: number;
  root: string;
  activePath: string | null;
  revealPath: string | null;
  onOpenFile: (absPath: string, relPath: string) => void;
  /** File-navigator redesign (§4): every unseen FILE's relPath, for the row dot. */
  unseenFiles: Set<string>;
  /** Every DIR relPath with at least one unseen descendant, mapped to that count. */
  unseenCountByDir: Record<string, number>;
  /** Card rail round (§3): currently-pinned relPaths, for the file row's hover pin toggle. */
  pinned: string[];
  onTogglePin: (relPath: string) => void;
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
          style={{ paddingLeft: indent }}
          className={cn(
            'flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors',
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
          <span className="min-w-0 truncate">{node.name}</span>
          {!!unseenCount && (
            <span className="text-accent shrink-0 text-xs tabular-nums">{unseenCount}</span>
          )}
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
              unseenFiles={unseenFiles}
              unseenCountByDir={unseenCountByDir}
              pinned={pinned}
              onTogglePin={onTogglePin}
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
      className={cn(
        'group flex w-full items-center text-sm transition-colors',
        active ? 'bg-bg-2 text-text-primary' : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <button
        type="button"
        onClick={() => onOpenFile(absPath, node.relPath)}
        title={node.name}
        style={{ paddingLeft: indent + 18 }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left"
      >
        <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 truncate">{displayTitle(node)}</span>
        {isUnseen && <span className="bg-accent size-1.5 shrink-0 rounded-full" />}
      </button>
      {/* Card rail round (§3): "a small pin action on hover" — rows have no context menu to hang this off (investigated). Always visible once pinned, so unpinning doesn't require a hover-hunt. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(node.relPath);
        }}
        aria-label={isPinned ? 'Unpin' : 'Pin'}
        title={isPinned ? 'Unpin' : 'Pin'}
        className={cn(
          'rounded-control mr-2 flex shrink-0 items-center justify-center p-1 transition-opacity',
          isPinned ? 'text-accent opacity-100' : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary'
        )}
      >
        <Pin className="size-3" strokeWidth={1.5} fill={isPinned ? 'currentColor' : 'none'} />
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
 * the shimmer-on-hover (`skill-label-shimmer`, defined in
 * `renderer/tokens.css`, itself gated behind `prefers-reduced-motion`) — a
 * gradient sweep through the type via `background-clip: text` — the app's
 * one deliberate decorative motion, reserved for skills so it stays
 * meaningful.
 */
function SkillsSection({
  files,
  root,
  activePath,
  onOpenFile,
  seenState,
}: {
  files: RigFileNode[];
  root: string;
  activePath: string | null;
  onOpenFile: (absPath: string, relPath: string) => void;
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
        {!!unseenCount && <span className="text-accent shrink-0 text-xs tabular-nums">{unseenCount}</span>}
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
              title={node.name}
              style={{ paddingLeft: SKILL_ROW_PADDING }}
              className={cn(
                'flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors',
                active
                  ? 'bg-bg-2 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
              )}
            >
              <Sparkles className="text-accent size-3.5 shrink-0" strokeWidth={1.5} />
              <span className="skill-label-shimmer min-w-0 truncate">{displayTitle(node)}</span>
              {isUnseen && <span className="bg-accent size-1.5 shrink-0 rounded-full" />}
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
