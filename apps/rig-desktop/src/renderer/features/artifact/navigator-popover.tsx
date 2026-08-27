import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { iconFor, rigFilesQueryKey } from '@renderer/features/workspace/file-tree';
import { rpc } from '@renderer/lib/ipc';
import { Popover, type PopoverAnchor } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import type { RigFileNode } from '@shared/rig/files';

/**
 * Session-first viewer: the file tree, demoted from resident panel to an
 * on-demand navigator — a filterable popover off the artefact pane's Files
 * button (and the (+) menu's "Open file…"). Reads the SAME cached listing
 * the pinned card and focus view share, content-only, so a system path
 * never appears here.
 *
 * Typing filters to a flat match list (name or path, case-insensitive) and
 * Enter opens the first match; with no query it is a plain collapsed tree.
 * Deliberately lean compared to the old `FileTree` panel: no sort modes,
 * no seen-state dots, no pinning — those live on the pinned card and the
 * focus view now. This surface answers exactly one question: "open which
 * file?"
 */

export function NavigatorPopover({
  root,
  rootId,
  anchor,
  open,
  onClose,
  onOpenFile,
  revealDir = null,
  align = 'left',
  gap = 6,
}: {
  root: string;
  rootId: string;
  anchor: PopoverAnchor;
  open: boolean;
  onClose: () => void;
  /** relPath included so callers can mark the open as seen without re-deriving it. */
  onOpenFile: (absPath: string, relPath: string) => void;
  /** Breadcrumb folder clicks land here — that folder (and its ancestors) start expanded. */
  revealDir?: string | null;
  /** The pinned card anchors this at a point left of itself (`align: 'right'`, gap 0); pane buttons keep the default. */
  align?: 'left' | 'right';
  gap?: number;
}) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: rigFilesQueryKey(root, rootId),
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
    enabled: open,
  });
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // A fresh open is a fresh question — stale filter text from last time
  // would silently hide most of the rig. A reveal target (breadcrumb
  // folder click) seeds its whole ancestor chain expanded.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    inputRef.current?.focus();
    if (revealDir) {
      const chain = new Set<string>();
      const segments = revealDir.split('/');
      for (let i = 1; i <= segments.length; i++) chain.add(segments.slice(0, i).join('/'));
      setExpanded((prev) => new Set([...prev, ...chain]));
    }
  }, [open, revealDir]);

  const tree = useMemo(() => filterToContentOnly(data ?? []), [data]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return null;
    const out: RigFileNode[] = [];
    const walk = (nodes: readonly RigFileNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'dir') walk(node.children ?? []);
        else if (node.name.toLowerCase().includes(q) || node.relPath.toLowerCase().includes(q)) {
          out.push(node);
        }
      }
    };
    walk(tree);
    return out;
  }, [tree, query]);

  const openFile = (node: RigFileNode) => {
    onOpenFile(`${root}/${node.relPath}`, node.relPath);
    onClose();
  };

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      role="dialog"
      align={align}
      gap={gap}
      estimatedWidth={264}
      minWidth={264}
      ariaLabel="Open a file"
      className="p-2"
    >
      <div className="border-border-hairline focus-within:border-border-strong mb-1.5 flex items-center gap-1.5 rounded-control border px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matches && matches.length > 0) openFile(matches[0]);
          }}
          placeholder="Filter files"
          className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
        />
      </div>
      {/* Loading, error, and empty are THREE states (impeccable P3) — a
          founder reading "No files" over a failed read believes their
          files are gone. */}
      {isPending ? (
        <div className="flex flex-col gap-1 px-1 py-1" aria-label="Loading files">
          <div className="bg-bg-2 h-6 animate-pulse rounded-control" />
          <div className="bg-bg-2 h-6 w-4/5 animate-pulse rounded-control" />
          <div className="bg-bg-2 h-6 w-3/5 animate-pulse rounded-control" />
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 px-2 py-3">
          <p className="text-xs text-text-muted">Couldn’t read this rig’s files.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="border-border-hairline hover:bg-bg-2 hover:text-text-primary ml-auto shrink-0 rounded-control border px-2 py-0.5 text-2xs text-text-secondary transition-colors"
          >
            Retry
          </button>
        </div>
      ) : matches ? (
        matches.length === 0 ? (
          <p className="px-2 py-3 text-xs text-text-muted">No files match.</p>
        ) : (
          matches
            .slice(0, 30)
            .map((node, index) => (
              <FileRow
                key={node.relPath}
                node={node}
                withPath
                // Enter opens the FIRST match — show which row that is.
                highlighted={index === 0}
                onOpen={() => openFile(node)}
              />
            ))
        )
      ) : tree.length === 0 ? (
        <p className="px-2 py-3 text-xs text-text-muted">
          No files yet — add one, or ask the agent to write.
        </p>
      ) : (
        <TreeLevel
          nodes={tree}
          depth={0}
          expanded={expanded}
          onToggleDir={(relPath) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(relPath)) next.delete(relPath);
              else next.add(relPath);
              return next;
            })
          }
          onOpenFile={openFile}
        />
      )}
    </Popover>
  );
}

function TreeLevel({
  nodes,
  depth,
  expanded,
  onToggleDir,
  onOpenFile,
}: {
  nodes: readonly RigFileNode[];
  depth: number;
  expanded: Set<string>;
  onToggleDir: (relPath: string) => void;
  onOpenFile: (node: RigFileNode) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <div key={node.relPath}>
            <button
              type="button"
              onClick={() => onToggleDir(node.relPath)}
              className="hover:bg-bg-2 flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-xs text-text-secondary transition-colors"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-text-muted transition-transform',
                  expanded.has(node.relPath) && 'rotate-90'
                )}
                strokeWidth={1.5}
              />
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
            {expanded.has(node.relPath) && (
              <TreeLevel
                nodes={node.children ?? []}
                depth={depth + 1}
                expanded={expanded}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        ) : (
          <FileRow key={node.relPath} node={node} depth={depth} onOpen={() => onOpenFile(node)} />
        )
      )}
    </>
  );
}

function FileRow({
  node,
  depth = 0,
  withPath = false,
  highlighted = false,
  onOpen,
}: {
  node: RigFileNode;
  depth?: number;
  /** Filter results show where the match lives; the tree's indentation already says it. */
  withPath?: boolean;
  /** The row Enter would open (the first filter match). */
  highlighted?: boolean;
  onOpen: () => void;
}) {
  const Icon = iconFor(node.name);
  const folder = node.relPath.includes('/')
    ? node.relPath.slice(0, node.relPath.lastIndexOf('/'))
    : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'hover:bg-bg-2 flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-xs transition-colors',
        highlighted && 'bg-bg-2'
      )}
      style={{ paddingLeft: withPath ? 8 : 8 + depth * 14 + 14 }}
    >
      <Icon className="size-3.5 shrink-0 text-text-secondary" strokeWidth={1.5} />
      <span className="min-w-0 truncate text-text-primary">{node.name}</span>
      {withPath && folder && (
        <span className="ml-auto min-w-0 shrink-0 truncate font-mono text-2xs text-text-muted">
          {folder}
        </span>
      )}
    </button>
  );
}
