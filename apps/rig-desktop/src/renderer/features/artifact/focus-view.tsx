import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ChevronRight, FoldVertical, MoreHorizontal, UnfoldVertical } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { relativeTime } from '@renderer/features/chat/session-history';
import type { DocSelectionRect } from '@renderer/features/docs/doc-editor';
import { DocEditor } from '@renderer/features/docs/doc-editor';
import { DocTabResource } from '@renderer/features/docs/doc-file-sync';
import {
  NewThreadCard,
  ThreadCard,
} from '@renderer/features/docs/comments/comments-margin';
import {
  attachDocComments,
  disposeDocComments,
  type AgentMention,
} from '@renderer/features/docs/comments/comments-store';
import { isPaintbrushArmed } from '@renderer/features/docs/paintbrush/paintbrush-gating';
import { paintbrushDecorations } from '@renderer/features/docs/paintbrush/paintbrush-decorations';
import { PaintbrushControl } from '@renderer/features/docs/paintbrush/paintbrush-control';
import { usePaintbrushEditorSync } from '@renderer/features/docs/paintbrush/use-paintbrush-editor-sync';
import { usePaintbrushMode } from '@renderer/features/docs/paintbrush/use-paintbrush';
import { useEverWrittenPaths, useRecentWrites } from '@renderer/features/workspace/write-activity';
import { events, rpc } from '@renderer/lib/ipc';
import { Popover, PopoverMenuItem, PopoverSeparator } from '@renderer/lib/ui/popover';
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
 *
 * Paintbrush (`docs/document-focus-design.md` §2 punch list, finding 6 —
 * "paintbrush in the stack") IS here, via a FLOATING CARD instead of a
 * margin: the header gets the same `PaintbrushControl` orb the editor tab
 * does, and a selection released inside an expanded, editable section
 * opens the same composer/thread components the margin rail uses
 * (`ThreadCard`/`NewThreadCard`, exported from `comments-margin.tsx` —
 * reused, not forked) as a popover anchored to the selection's rect,
 * clamped to the viewport. Deferred this pass: browsing a file's OTHER,
 * non-paintbrush comment threads from the stack — there is still no
 * margin to list them in, only the single thread a stroke just started or
 * reactivated.
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
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: rigFilesQueryKey(root, rootId),
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
  });
  // Feedback round 1: no Refresh button — the view follows the disk on its
  // own. The listing invalidates on every fs event under this root (the
  // watch registration lives in App.tsx), and each expanded section's
  // document already reloads itself when clean.
  useEffect(() => {
    const key = rigFilesQueryKey(root, rootId);
    return events.on(rigFileChangeChannel, ({ rootId: changed }) => {
      if (changed !== rootId) return;
      void queryClient.invalidateQueries({ queryKey: key });
    });
  }, [root, rootId, queryClient]);

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
  // Paintbrush (see this file's own doc comment): one mode/agent choice
  // for the whole stack, exactly like the editor tab's header — armed
  // here, a selection release in any expanded section below opens the
  // floating card.
  const paintbrush = usePaintbrushMode();
  const [filter, setFilter] = useState<'all' | 'unseen'>('all');
  // The cap exists so a huge rig doesn't stack dozens of sections at once
  // — but the way past it belongs HERE, not in a pointer to another
  // surface (feedback round 3). One click reveals the rest; collapsed
  // sections cost nothing until expanded, so this is safe at any size.
  const [showAll, setShowAll] = useState(false);
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

  // `total` is the honest size of the filtered set; `sections` is the
  // rendered slice. The header owns admitting the difference (impeccable
  // P2: "10 files · 14 unseen" over a silent cap was incoherent).
  const { sections, total } = useMemo(() => {
    const files = flattenFiles(contentTree).filter((node) => node.mtimeMs !== undefined);
    const rank = (relPath: string) =>
      activePaths.has(relPath) ? 0 : unseenFiles.has(relPath) ? 1 : 2;
    const filtered = files
      .sort((a, b) => rank(a.relPath) - rank(b.relPath) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      .filter((node) => filter === 'all' || unseenFiles.has(node.relPath));
    return {
      sections: showAll ? filtered : filtered.slice(0, MAX_SECTIONS),
      total: filtered.length,
    };
  }, [contentTree, activePaths, unseenFiles, filter, showAll]);

  const markViewed = (relPath: string) => {
    void rpc.rig.seenState.markSeen({ bindingId, relPath });
    setSeenState((prev) =>
      prev ? { ...prev, seen: { ...prev.seen, [relPath]: Date.now() } } : prev
    );
  };

  const optionsRef = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const markAllViewed = () => {
    const relPaths = [...unseenFiles];
    if (relPaths.length === 0) return;
    void rpc.rig.seenState.markAllSeen({ bindingId, relPaths });
    const now = Date.now();
    setSeenState((prev) =>
      prev
        ? {
            ...prev,
            seen: { ...prev.seen, ...Object.fromEntries(relPaths.map((p) => [p, now])) },
          }
        : prev
    );
  };
  const setAllExpanded = (expanded: boolean) => {
    setToggled(new Map(sections.map((node) => [node.relPath, expanded])));
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-border-hairline flex h-10 shrink-0 items-center gap-2.5 border-b px-4">
        <span className="text-xs font-medium text-text-primary">Recent files</span>
        <span className="font-mono text-2xs text-text-muted">
          {sections.length < total ? `${sections.length} of ${total}` : `${total} files`}
          {unseenFiles.size > 0 && ` · ${unseenFiles.size} new`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <PaintbrushControl
            on={paintbrush.on}
            toggle={paintbrush.toggle}
            agents={paintbrush.agents}
            selected={paintbrush.selected}
            selectAgent={paintbrush.selectAgent}
            streaming={false}
            showCoachMark={paintbrush.showCoachMark}
            dismissCoachMark={paintbrush.dismissCoachMark}
          />
          {/* Default (All) first — the resting state highlights the first pill. */}
          <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </FilterPill>
          <FilterPill active={filter === 'unseen'} onClick={() => setFilter('unseen')}>
            New
          </FilterPill>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={optionsRef}
                  type="button"
                  onClick={() => setOptionsOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={optionsOpen}
                  aria-label="View options"
                  className="hover:bg-bg-2 hover:text-text-primary flex size-6 items-center justify-center rounded-control text-text-muted transition-colors"
                >
                  <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
                </button>
              }
            />
            <TooltipContent side="bottom">View options</TooltipContent>
          </Tooltip>
          <Popover
            anchor={optionsRef}
            open={optionsOpen}
            onClose={() => setOptionsOpen(false)}
            role="menu"
            align="right"
            gap={4}
            estimatedWidth={200}
            minWidth={200}
            ariaLabel="Focus view options"
          >
            <PopoverMenuItem
              icon={CheckCheck}
              // The count admits the scope: ALL new files, shown or not.
              label={
                unseenFiles.size > 0 ? `Mark all ${unseenFiles.size} as viewed` : 'Mark all as viewed'
              }
              disabled={unseenFiles.size === 0}
              onSelect={() => {
                setOptionsOpen(false);
                markAllViewed();
              }}
            />
            <PopoverSeparator />
            <PopoverMenuItem
              icon={UnfoldVertical}
              label="Expand all"
              onSelect={() => {
                setOptionsOpen(false);
                setAllExpanded(true);
              }}
            />
            <PopoverMenuItem
              icon={FoldVertical}
              label="Collapse all"
              onSelect={() => {
                setOptionsOpen(false);
                setAllExpanded(false);
              }}
            />
          </Popover>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Loading, error, and empty are THREE states (impeccable P3):
            "No files" over a failed read tells a founder their files are
            gone — the scariest wrong message this surface could show.
            The error surfaces only when there is NOTHING to render: a
            refetch that loses a race (react-query keeps the last good
            data) must not replace a perfectly readable listing with an
            alarm. */}
        {isPending ? (
          <div className="flex flex-col gap-2 px-4 py-4" aria-label="Loading files">
            <div className="bg-bg-2 h-8 animate-pulse rounded-control" />
            <div className="bg-bg-2 h-8 w-4/5 animate-pulse rounded-control" />
            <div className="bg-bg-2 h-8 w-3/5 animate-pulse rounded-control" />
          </div>
        ) : isError && !data ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-sm text-text-muted">Couldn’t read this rig’s files.</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="border-border-hairline hover:bg-bg-2 hover:text-text-primary rounded-control border px-3 py-1 text-xs text-text-secondary transition-colors"
            >
              Retry
            </button>
          </div>
        ) : sections.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            {filter === 'unseen'
              ? 'Nothing new — all caught up.'
              : 'No files yet — add one, or ask the agent to write.'}
          </div>
        ) : (
          <>
            {sections.map((node) => {
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
                  paintbrush={{ on: paintbrush.on, mention: paintbrush.mention }}
                />
              );
            })}
            {total > sections.length && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="hover:bg-bg-1 hover:text-text-primary w-full px-4 py-3 text-center font-mono text-2xs text-text-muted transition-colors"
              >
                Show {total - sections.length} more
              </button>
            )}
          </>
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
  paintbrush,
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
  paintbrush: { on: boolean; mention: AgentMention | null };
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
                {/* Dylan's call (critique round): stay an editor everywhere,
                    but SAY when a section is read-only — here, while the
                    agent holds the pen. */}
                writing… · read-only
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
      {expanded && (
        <FocusBody
          root={root}
          rootId={rootId}
          relPath={node.relPath}
          readOnly={active}
          paintbrush={paintbrush}
        />
      )}
    </section>
  );
}

/**
 * One section's live document — same `DocTabResource`/`DocEditor` pair the
 * editor tab uses, minus header chrome and the margin rail. Mounted only
 * while its section is expanded, so a big rig never pays for ten live
 * editors. Paintbrush wiring (comments store attach, the CM6 overlay
 * decoration, the floating card) lives in `FocusBodyEditor` below, kept as
 * its own child component so those hooks only ever run once `resource` is
 * a real, non-null `DocTabResource` — this component's own `resource` can
 * still be null (an unsupported type, still loading), which plain hooks
 * can't conditionally skip around.
 */
const FocusBody = observer(function FocusBody({
  root,
  rootId,
  relPath,
  readOnly = false,
  paintbrush,
}: {
  root: string;
  rootId: string;
  relPath: string;
  /** While the agent holds the pen: the document stays visible and live, but a skimming scroll can't type into a mid-thought edit. */
  readOnly?: boolean;
  paintbrush: { on: boolean; mention: AgentMention | null };
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
    <FocusBodyEditor
      resource={resource}
      language={language}
      readOnly={readOnly}
      // Paintbrush stays markdown-only, matching the editor tab
      // (`artifact-view.tsx`'s `commentsEnabled`), and never while the
      // agent holds the pen — selecting into a mid-write buffer to start
      // a stroke would race the very write it's reading.
      paintbrushEligible={language === 'markdown' && !readOnly}
      paintbrush={paintbrush}
    />
  );
});

/**
 * The document editor plus the paintbrush wiring for one stack section.
 * Split out of `FocusBody` so every hook below can assume a real
 * `resource` — see that component's own doc comment.
 */
const FocusBodyEditor = observer(function FocusBodyEditor({
  resource,
  language,
  readOnly,
  paintbrushEligible,
  paintbrush,
}: {
  resource: DocTabResource;
  language: EditorLanguage;
  readOnly: boolean;
  paintbrushEligible: boolean;
  paintbrush: { on: boolean; mention: AgentMention | null };
}) {
  // Attached synchronously in a `useMemo` (not an effect) for the same
  // reason `artifact-view.tsx`'s `EditableArtifactPane` does it that way:
  // the paintbrush CM6 extension must already be in `extensionFactories`
  // before `DocEditor`'s own mount effect reads it, which runs before this
  // component's own effects do (child-before-parent), not after.
  //
  // `decorationsPushed` guards against `paintbrushEligible` flipping back
  // on more than once over this component's life (`readOnly` toggling as
  // the agent starts/stops writing this same section again) — without it,
  // each re-eligible pass would push another `paintbrushDecorations()`
  // factory onto the SAME resource's `extensionFactories`, double-painting
  // (then triple-, then...) the same overlay on every later mount.
  const decorationsPushed = useRef(false);
  const comments = useMemo(() => {
    if (!paintbrushEligible) return null;
    const store = attachDocComments(resource);
    if (!decorationsPushed.current) {
      resource.extensionFactories.push(() => paintbrushDecorations());
      decorationsPushed.current = true;
    }
    return store;
  }, [paintbrushEligible, resource]);

  useEffect(() => {
    if (!comments) return;
    comments.setVisible(true);
    return () => disposeDocComments(resource);
  }, [comments, resource]);

  const paintbrushOverlay = comments?.paintbrushOverlay ?? null;
  usePaintbrushEditorSync(resource, 'edit', paintbrushOverlay);

  const armed = isPaintbrushArmed(paintbrush) && !readOnly && comments !== null;
  const [pendingRect, setPendingRect] = useState<DocSelectionRect | null>(null);

  useEffect(() => {
    if (!comments) return;
    return resource.subscribeSelection((selection) => {
      if (!armed) return;
      if (selection.text.trim().length === 0 || selection.rect === null) return;
      // CM6 selections carry exact source offsets — build the anchor
      // straight from them (`buildAnchorFromRange`, inside `openComposer`
      // → `create`), never a verbatim-text search, same as the editor
      // tab's `CommentSelectionButton`.
      setPendingRect(selection.rect);
      comments.openComposer(
        selection.text,
        { start: selection.from, end: selection.to },
        paintbrush.mention
      );
    });
  }, [comments, resource, armed, paintbrush.mention]);

  // The floating card shows for the composer (a stroke just started) OR
  // the one paintbrush thread just created/reactivated — never the whole
  // thread history (deferred, see this file's own doc comment).
  const showFloatingCard =
    comments !== null &&
    (comments.composerQuote !== null ||
      (comments.activeThreadId !== null && comments.isPaintbrushThread(comments.activeThreadId)));

  useEffect(() => {
    if (!showFloatingCard) setPendingRect(null);
  }, [showFloatingCard]);

  // Click-away closes the card — the only dismissal path besides Cancel
  // (wired inside `NewThreadCard` itself) and Resolve (inside `ThreadCard`,
  // which only clears `activeThreadId` if it resolves the ACTIVE thread —
  // safe either way since `setActiveThread` is idempotent).
  useEffect(() => {
    if (!showFloatingCard || !comments) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-paintbrush-floating-card]')) return;
      comments.setActiveThread(null);
      comments.closeComposer();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [showFloatingCard, comments]);

  const activeThread =
    comments !== null && comments.activeThreadId !== null
      ? comments.threads.find((t) => t.root.id === comments.activeThreadId)
      : undefined;

  return (
    <div className="popover-in relative pb-4">
      <DocEditor
        // readOnly rides the key: CM6 editability is baked at state
        // construction here, and the write window opening/closing is rare
        // enough that a remount is the honest simple mechanism.
        key={`${resource.path}:${readOnly ? 'ro' : 'rw'}`}
        ref={resource.editorRef}
        path={resource.path}
        initialContent={resource.content}
        language={language}
        onChange={resource.handleEditorChange}
        onSave={() => void resource.flush()}
        onSelectionChange={comments ? resource.handleSelectionChange : undefined}
        extraExtensions={
          readOnly
            ? [
                ...resource.extensionFactories,
                () => [EditorState.readOnly.of(true), EditorView.editable.of(false)],
              ]
            : resource.extensionFactories
        }
      />
      {comments && showFloatingCard && pendingRect && (
        <PaintbrushFloatingCard anchorRect={pendingRect}>
          {comments.composerQuote !== null ? (
            <NewThreadCard store={comments} hasAnchor />
          ) : activeThread ? (
            <ThreadCard store={comments} thread={activeThread} />
          ) : null}
        </PaintbrushFloatingCard>
      )}
    </div>
  );
});

/**
 * The composer/thread popover for a stack section's paintbrush stroke —
 * portaled to `document.body`, `position: fixed`, anchored beside the
 * selection rect and clamped to the viewport (zero layout shift, same
 * discipline as the editor tab's own paintbrush additions). Content is
 * whichever of `NewThreadCard`/`ThreadCard` (`comments-margin.tsx`,
 * exported for exactly this reuse — never forked) the caller passes.
 */
function PaintbrushFloatingCard({
  anchorRect,
  children,
}: {
  anchorRect: DocSelectionRect;
  children: React.ReactNode;
}) {
  const CARD_WIDTH = 300;
  const GAP = 6;
  const EDGE = 8;

  const left = Math.min(Math.max(anchorRect.left, EDGE), window.innerWidth - CARD_WIDTH - EDGE);
  const below = anchorRect.bottom + GAP;
  // A rough own-height guess (favors "below" unless there's clearly no
  // room) — the card's outer wrapper caps `maxHeight` to whatever room is
  // actually left either way, so a wrong guess here costs a scrollbar
  // inside the card, never an off-screen one.
  const fitsBelow = below + 120 + EDGE <= window.innerHeight;
  const top = fitsBelow ? below : Math.max(EDGE, anchorRect.top - GAP);
  const maxHeight = fitsBelow ? window.innerHeight - top - EDGE : anchorRect.top - GAP - EDGE;

  return createPortal(
    <div
      // No border/background/shadow of its own — `NewThreadCard`/
      // `ThreadCard` already render the full card shell (`Card` in
      // `comments-margin.tsx`); this is purely a positioning wrapper, or
      // the two would double up into a card-inside-a-card look.
      data-paintbrush-floating-card
      className="fixed z-50 overflow-y-auto"
      style={{ left, top, width: CARD_WIDTH, maxHeight }}
    >
      {children}
    </div>,
    document.body
  );
}
