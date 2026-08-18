import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, File, FileText, Folder, FolderOpen, Table } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { rigFileChangeChannel } from '@shared/rig/files';
import type { RigFileNode } from '@shared/rig/files';

/**
 * Real filesystem tree for the opened rig, via `rpc.rig.files.list` — a small,
 * new main rpc (see `main/rig/files.ts`), not a port of emdash's file-tree
 * component: that one is wired through the emdash project/workspace registry
 * (`workspace.fileTree`, `FileTreeProjector`) this app doesn't carry (see the
 * P0 report). Recursive listing, folders collapsible, file-type icons, mono
 * filenames, active row = `bg-2` + text shift — no colored left rail, per the
 * design system's hard rule.
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
 */

const HIGHLIGHT_MS = 1400;

function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx' || ext === 'txt') return FileText;
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx') return Table;
  return File;
}

export function FileTree({
  root,
  activePath,
  revealPath,
  onOpenFile,
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
}) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['rig', 'files', 'list', root], [root]);
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
  // ignores `.git`/`.rig`/`node_modules`/dotfile noise before this ever
  // fires, so no extra debouncing needed here.
  useEffect(() => {
    void rpc.rig.files.watch(root);
    const off = events.on(rigFileChangeChannel, ({ root: changedRoot }) => {
      if (changedRoot !== root) return;
      void queryClient.invalidateQueries({ queryKey });
    });
    return () => {
      off();
      void rpc.rig.files.unwatch(root);
    };
  }, [root, queryClient, queryKey]);

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
    return <p className="text-text-muted px-3 py-2 text-xs">Empty folder.</p>;
  }

  return (
    <div className="flex flex-col py-1">
      {data.map((node) => (
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
    const FolderIcon = open ? FolderOpen : Folder;

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
          <FolderIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
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

  const Icon = iconFor(node.name);
  const active = absPath === activePath;
  return (
    <button
      type="button"
      onClick={() => onOpenFile(absPath)}
      style={{ paddingLeft: indent + 18 }}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-3 text-left font-mono text-sm transition-colors',
        active
          ? 'bg-bg-2 text-text-primary'
          : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
      <span className="min-w-0 truncate">{node.name}</span>
    </button>
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
