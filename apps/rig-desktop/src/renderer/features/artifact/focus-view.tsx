import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { DocEditor } from '@renderer/features/docs/doc-editor';
import { DocTabResource } from '@renderer/features/docs/doc-file-sync';
import { useEverWrittenPaths, useRecentWrites } from '@renderer/features/workspace/write-activity';
import { events, rpc } from '@renderer/lib/ipc';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import { rigFileChangeChannel, type RigFileNode } from '@shared/rig/files';
import { computeUnseenSummary, type SeenMap } from '@shared/rig/seen-state';
import { rigFilesQueryKey } from '@renderer/features/workspace/file-tree';
import type { EditorLanguage } from './file-type';
import { useFileType } from './use-file-type';

/**
 * Session-first viewer, view type 2: the FOCUS VIEW — the working set as
 * one vertical, scrollable reading surface. A stack of file sections,
 * each a sticky header (name, provenance, "Mark as viewed") over the live
 * document; the review-screen grammar from Dylan's references, pointed at
 * files instead of diffs.
 *
 * Ordering is by what deserves attention: files being written right now,
 * then unseen changes (newest first), then the recently-viewed tail —
 * which starts collapsed, so the default scroll length is exactly "what's
 * new here." Documents are the same editable CM6 surface as the editor
 * tab (same `DocTabResource`), and a section with no unsaved edits
 * reloads itself when the file changes on disk — reading a rig while an
 * agent works it is the whole point of this view.
 *
 * Deliberately not here (v1): the margin comment rail — its anchor
 * geometry assumes one document per scroll container; comments stay in
 * the editor tab for now.
 */

const MAX_SECTIONS = 10;

function flattenFiles(nodes: readonly RigFileNode[]): RigFileNode[] {
  const out: RigFileNode[] = [];
  const walk = (list: readonly RigFileNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') walk(node.children ?? []);
      else out.push(node);
    }
  };
  walk(nodes);
  return out;
}

export function FocusView({
  root,
  rootId,
  bindingId,
}: {
  root: string;
  rootId: string;
  bindingId: string;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: rigFilesQueryKey(root, rootId),
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
  });

  const [seenState, setSeenState] = useState<{ baselineAt: number; seen: SeenMap } | null>(null);
  useEffect(() => {
    let alive = true;
    const fetchSeen = () => {
      void rpc.rig.seenState.getState({ bindingId }).then((state) => {
        if (alive) setSeenState(state);
      });
    };
    fetchSeen();
    const off = events.on(rigFileChangeChannel, ({ rootId: changed }) => {
      if (changed === rootId) fetchSeen();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId, rootId]);

  const recentWrites = useRecentWrites(root);
  const agentWritten = useEverWrittenPaths(root);
  const [filter, setFilter] = useState<'all' | 'unseen'>('all');
  /** Per-file explicit open/closed choices, layered over the defaults. */
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());

  const contentTree = useMemo(() => filterToContentOnly(data ?? []), [data]);
  const unseenFiles = useMemo(
    () =>
      seenState
        ? computeUnseenSummary(contentTree, seenState.seen, seenState.baselineAt).unseenFiles
        : new Set<string>(),
    [contentTree, seenState]
  );
  const activePaths = useMemo(() => new Set(recentWrites.map((w) => w.relPath)), [recentWrites]);

  const sections = useMemo(() => {
    const files = flattenFiles(contentTree).filter((node) => node.mtimeMs !== undefined);
    const rank = (relPath: string) =>
      activePaths.has(relPath) ? 0 : unseenFiles.has(relPath) ? 1 : 2;
    return files
      .sort((a, b) => rank(a.relPath) - rank(b.relPath) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      .filter((node) => filter === 'all' || unseenFiles.has(node.relPath))
      .slice(0, MAX_SECTIONS);
  }, [contentTree, activePaths, unseenFiles, filter]);

  const markViewed = (relPath: string) => {
    void rpc.rig.seenState.markSeen({ bindingId, relPath });
    setSeenState((prev) =>
      prev ? { ...prev, seen: { ...prev.seen, [relPath]: Date.now() } } : prev
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-border-hairline flex h-10 shrink-0 items-center gap-2.5 border-b px-4">
        <span className="text-xs font-medium text-text-primary">Working set</span>
        <span className="font-mono text-2xs text-text-muted">
          {sections.length} files{unseenFiles.size > 0 && ` · ${unseenFiles.size} unseen`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <FilterPill active={filter === 'unseen'} onClick={() => setFilter('unseen')}>
            Unseen
          </FilterPill>
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </FilterPill>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() =>
                    void queryClient.invalidateQueries({
                      queryKey: rigFilesQueryKey(root, rootId),
                    })
                  }
                  aria-label="Refresh"
                  className="hover:bg-bg-2 hover:text-text-primary flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
                >
                  <RefreshCw className="size-3.5" strokeWidth={1.5} />
                </button>
              }
            />
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            {filter === 'unseen' ? 'Nothing unseen — all caught up.' : 'No files here yet.'}
          </div>
        ) : (
          sections.map((node) => {
            const active = activePaths.has(node.relPath);
            const unseen = unseenFiles.has(node.relPath);
            // Default: what deserves attention is open, the viewed tail is
            // closed. An explicit click wins over the default either way.
            const expanded = toggled.get(node.relPath) ?? (active || unseen);
            return (
              <FocusSection
                key={node.relPath}
                root={root}
                rootId={rootId}
                node={node}
                active={active}
                unseen={unseen}
                byAgent={agentWritten.has(node.relPath)}
                expanded={expanded}
                onToggle={() =>
                  setToggled((prev) => {
                    const next = new Map(prev);
                    next.set(node.relPath, !expanded);
                    return next;
                  })
                }
                onMarkViewed={() => markViewed(node.relPath)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-chip px-2 py-0.5 text-2xs font-medium transition-colors',
        active ? 'bg-bg-2 text-text-primary' : 'text-text-muted hover:text-text-primary'
      )}
    >
      {children}
    </button>
  );
}

function FocusSection({
  root,
  rootId,
  node,
  active,
  unseen,
  byAgent,
  expanded,
  onToggle,
  onMarkViewed,
}: {
  root: string;
  rootId: string;
  node: RigFileNode;
  active: boolean;
  unseen: boolean;
  byAgent: boolean;
  expanded: boolean;
  onToggle: () => void;
  onMarkViewed: () => void;
}) {
  return (
    <section className="border-border-hairline border-b">
      <div className="bg-bg-1 sticky top-0 z-10 flex h-9 items-center gap-2 px-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-text-muted transition-transform',
              expanded && 'rotate-90'
            )}
            strokeWidth={1.5}
          />
          {unseen && !active && (
            <span className="unseen-dot-in bg-accent size-[5px] shrink-0 rounded-full" />
          )}
          <span
            className={cn(
              'min-w-0 truncate text-xs font-medium text-text-primary',
              active && 'active-shimmer'
            )}
          >
            {node.name}
          </span>
          <span className="flex shrink-0 items-center gap-1 font-mono text-2xs text-text-muted">
            {active ? (
              <>
                <RigMark size={10} className="shrink-0" />
                writing…
              </>
            ) : (
              <>
                {byAgent && <RigMark size={10} className="shrink-0 opacity-60" />}
                {node.mtimeMs !== undefined && relativeTime(node.mtimeMs, Date.now())}
              </>
            )}
          </span>
        </button>
        {unseen && !active && (
          <button
            type="button"
            onClick={onMarkViewed}
            className="border-border-hairline hover:bg-bg-2 hover:text-text-primary shrink-0 rounded-control border px-2 py-0.5 text-2xs text-text-muted transition-colors"
          >
            Mark as viewed
          </button>
        )}
      </div>
      {expanded && <FocusBody root={root} rootId={rootId} relPath={node.relPath} />}
    </section>
  );
}

/**
 * One section's live document — same `DocTabResource`/`DocEditor` pair the
 * editor tab uses, minus header chrome and comments. Mounted only while
 * its section is expanded, so a big rig never pays for ten live editors.
 */
const FocusBody = observer(function FocusBody({
  root,
  rootId,
  relPath,
}: {
  root: string;
  rootId: string;
  relPath: string;
}) {
  const absPath = `${root}/${relPath}`;
  const fileInfo = useFileType(root, rootId, absPath);
  const type = fileInfo?.type ?? null;
  const editable = type !== null && (type.category === 'markdown' || type.category === 'text');
  const language: EditorLanguage =
    type !== null && type.category === 'text' ? type.language : 'markdown';

  const resource = useMemo(
    () => (editable ? new DocTabResource({ path: absPath }, { root, rootId }) : null),
    [editable, absPath, root, rootId]
  );
  useEffect(() => {
    if (!resource) return;
    return () => resource.dispose();
  }, [resource]);

  // Reading view first: a clean (no unsaved edits) section follows the
  // disk — an agent's save shows up here without a Reload pill to click.
  useEffect(() => {
    if (!resource) return;
    if (resource.hasDiskUpdate && resource.saveState === 'saved') {
      void resource.reloadFromDisk();
    }
  }, [resource, resource?.hasDiskUpdate, resource?.saveState]);

  if (type === null) {
    return <div className="px-10 py-6 text-xs text-text-muted">Loading…</div>;
  }
  if (!editable || !resource) {
    return (
      <div className="px-10 py-6 text-xs text-text-muted">
        No inline preview for this file — open it as a tab instead.
      </div>
    );
  }
  if (resource.isLoading) {
    return <div className="px-10 py-6 text-xs text-text-muted">Loading…</div>;
  }
  if (resource.loadError) {
    return (
      <div className="text-danger px-10 py-6 text-xs">Could not open: {resource.loadError}</div>
    );
  }
  return (
    <div className="pb-4">
      <DocEditor
        key={resource.path}
        ref={resource.editorRef}
        path={resource.path}
        initialContent={resource.content}
        language={language}
        onChange={resource.handleEditorChange}
        onSave={() => void resource.flush()}
        extraExtensions={resource.extensionFactories}
      />
    </div>
  );
});
