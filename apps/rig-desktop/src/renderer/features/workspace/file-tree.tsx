import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { detectByExtension } from '@renderer/features/artifact/file-type';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { classifyEntryCategory } from '@shared/rig/file-navigator-categories';
import { rigFileChangeChannel } from '@shared/rig/files';
import type { RigFileNode } from '@shared/rig/files';
import { FILE_ICON_ASSETS, fileIconTypeFor, type FileIconType } from './file-icon';
import { FolderIcon } from './folder-icon';

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
 * filename with its extension hidden; the real filename lives in the row's
 * tooltip. Entries split into three categories
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

/** The document's display name: its extracted title, else the filename with a recognized extension hidden. */
function displayTitle(node: RigFileNode): string {
  if (node.kind === 'dir') return node.name;
  if (node.title) return node.title;
  return stripRecognizedExtension(node.name);
}

/** Only strips a real `name.ext` shape for a RECOGNIZED extension — a dotfile like `.gitignore` or an unknown type is shown in full. */
function stripRecognizedExtension(name: string): string {
  if (!detectByExtension(name)) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

function FileIconImg({ type, className }: { type: FileIconType; className?: string }) {
  const asset = FILE_ICON_ASSETS[type];
  return (
    <img
      src={asset.src1x}
      srcSet={`${asset.src1x} 1x, ${asset.src2x} 2x`}
      alt=""
      draggable={false}
      className={className}
    />
  );
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
  activePath,
  revealPath,
  onOpenFile,
  justAttachedSyncing = false,
  showSystemFiles = false,
}: {
  root: string;
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
  const queryKey = useMemo(() => ['rig', 'files', 'list', root], [root]);
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
          onOpenFile={onOpenFile}
        />
      ))}
      <SkillsSection files={skillFiles} root={root} activePath={activePath} onOpenFile={onOpenFile} />
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
}: {
  node: RigFileNode;
  depth: number;
  root: string;
  activePath: string | null;
  revealPath: string | null;
  onOpenFile: (absPath: string) => void;
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
          <FolderIcon open={open} className="size-[18px] shrink-0" />
          <span className="min-w-0 truncate">{node.name}</span>
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
            />
          ))}
      </div>
    );
  }

  const active = absPath === activePath;
  return (
    <button
      type="button"
      onClick={() => onOpenFile(absPath)}
      title={node.name}
      style={{ paddingLeft: indent + 18 }}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors',
        active
          ? 'bg-bg-2 text-text-primary'
          : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <FileIconImg type={fileIconTypeFor(node.name)} className="size-[18px] shrink-0" />
      <span className="min-w-0 truncate">{displayTitle(node)}</span>
    </button>
  );
}

/**
 * Skills, grouped into one section at the bottom, collapsed by default
 * (`docs/file-navigator-design.md` §1) — flat and sorted by title A-Z
 * rather than mirroring their original folder structure: the design doc
 * asks for "a single Skills section," not a second parallel tree, and a
 * flat list keeps that section legible even when skills live at different
 * depths (`.claude/skills/<name>/SKILL.md`, a top-level `AGENTS.md`, a
 * `.claude/commands/*.md`). Each row gets the shimmer-on-hover
 * (`skill-row-shimmer`, defined in `renderer/tokens.css`, itself gated
 * behind `prefers-reduced-motion`) — the app's one deliberate decorative
 * motion, reserved for skills so it stays meaningful.
 */
function SkillsSection({
  files,
  root,
  activePath,
  onOpenFile,
}: {
  files: RigFileNode[];
  root: string;
  activePath: string | null;
  onOpenFile: (absPath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;

  const sorted = [...files].sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));

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
        <FileIconImg type="skill" className="size-[18px] shrink-0" />
        <span className="min-w-0 truncate">Skills</span>
      </button>
      {open &&
        sorted.map((node) => {
          const absPath = `${root}/${node.relPath}`;
          const active = absPath === activePath;
          return (
            <button
              key={node.relPath}
              type="button"
              onClick={() => onOpenFile(absPath)}
              title={node.name}
              style={{ paddingLeft: SKILL_ROW_PADDING }}
              className={cn(
                'skill-row-shimmer flex w-full items-center gap-1.5 py-1 pr-3 text-left text-sm transition-colors',
                active
                  ? 'bg-bg-2 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
              )}
            >
              <FileIconImg type="skill" className="size-[18px] shrink-0" />
              <span className="min-w-0 truncate">{displayTitle(node)}</span>
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
