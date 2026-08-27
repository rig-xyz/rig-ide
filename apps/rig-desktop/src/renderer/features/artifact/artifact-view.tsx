import { ChevronRight, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { commentDecorations } from '@renderer/features/docs/comments/comment-decorations';
import { CommentSelectionButton } from '@renderer/features/docs/comments/comment-selection';
import { MarginRail, shouldShowMargin } from '@renderer/features/docs/comments/comments-margin';
import {
  attachDocComments,
  disposeDocComments,
} from '@renderer/features/docs/comments/comments-store';
import { DocEditor } from '@renderer/features/docs/doc-editor';
import { DocTabResource } from '@renderer/features/docs/doc-file-sync';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { classifyEntryCategory, relPathFromRoot } from '@shared/rig/file-navigator-categories';
import { breadcrumbSegments, type BreadcrumbSegment } from './breadcrumb';
import type { EditorLanguage } from './file-type';
import { ImageArtifact } from './image-artifact';
import { ShareButton } from './share-popover';
import { UnsupportedArtifact } from './unsupported-artifact';
import { useFileType } from './use-file-type';

/**
 * The document-level view (`docs/collab-pivot-spec.md` §4.3): the living
 * markdown editor, centered ~68ch, with margin comment cards floating beside
 * their anchors. This is the P0 POC's star — everything else (workspace file
 * tree, folder-open flow) is chrome around it.
 *
 * Round (beyond-markdown): this used to be markdown-only end to end —
 * `App.tsx`'s `openFile` gated on `.md` and refused anything else with a
 * toast, so this component never had to consider another type. Now it
 * routes on `useFileType`'s detection: markdown and other text/code/config
 * share ONE editable pane (`EditableArtifactPane`, same `DocTabResource`/
 * `DocEditor` plumbing — both are already fully type-agnostic, see that
 * pane's own doc comment for the investigation), images get a quiet
 * read-only viewer, and anything genuinely unsupported gets a designed
 * empty state instead of the old blanket refusal. The header's Back +
 * breadcrumb (`ArtifactHeaderBar`) stay identical across every type; only
 * the trailing bits (Share, the Saved indicator, the disk-reload pill) are
 * specific to the editable pane, which renders its own copy of the same
 * shell so there's exactly one header implementation, not four.
 */

export const ArtifactView = observer(function ArtifactView({
  root,
  rootId,
  path,
  onNavigateFolder,
}: {
  /** The bound rig's workspace root — scopes the file watcher. */
  root: string;
  rootId: string;
  /** Absolute path of the file being viewed. */
  path: string;
  /** Open the navigator revealing this folder — folder breadcrumb segments. (Feedback round 5: the Files button itself lives on the tab strip now, one level up; closing is the tab's ×.) */
  onNavigateFolder: (relPath: string) => void;
}) {
  const fileInfo = useFileType(root, rootId, path);
  const crumbs = useMemo(() => breadcrumbSegments(root, path), [root, path]);
  const type = fileInfo?.type ?? null;
  // File-navigator redesign: a skill file (`.claude/skills`, `.agents/skills`,
  // `.claude/commands`, `AGENTS.md`/`CLAUDE.md`) gets a friendly header
  // instead of opening like any other document — see `EditableArtifactPane`'s
  // banner below.
  const isSkill = useMemo(
    () => classifyEntryCategory(relPathFromRoot(root, path)) === 'skills',
    [root, path]
  );

  if (type !== null && (type.category === 'markdown' || type.category === 'text')) {
    return (
      <EditableArtifactPane
        root={root}
        rootId={rootId}
        path={path}
        crumbs={crumbs}
        language={type.category === 'markdown' ? 'markdown' : type.language}
        // Comments/Share stay markdown-only this round — see this file's
        // header comment and the round report for why (both are genuinely
        // path-based/offset-based under the hood, not markdown-coupled;
        // this is a scope choice, not a technical limit). Extending either
        // to other text types is a real, cheap follow-up if wanted.
        commentsEnabled={type.category === 'markdown'}
        showShare={type.category === 'markdown'}
        isSkill={isSkill}
        onNavigateFolder={onNavigateFolder}
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeaderBar path={path} crumbs={crumbs} onNavigateFolder={onNavigateFolder} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {type === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
            Loading…
          </div>
        ) : type.category === 'image' ? (
          <ImageArtifact root={root} rootId={rootId} path={path} mime={type.mime} />
        ) : (
          <UnsupportedArtifact
            root={root}
            rootId={rootId}
            path={path}
            size={fileInfo?.size ?? null}
          />
        )}
      </div>
    </div>
  );
});

/**
 * Back + breadcrumb — the one piece of chrome every file type shares,
 * unchanged from before this round. Each content-specific view (this
 * component's own callers) supplies whatever ELSE belongs in the header
 * row (the reload pill, Share, the Saved indicator) as `trailing`, so
 * there's exactly one implementation of Back/breadcrumb rather than one
 * per type.
 */
function ArtifactHeaderBar({
  path,
  crumbs,
  onNavigateFolder,
  trailing,
  status,
}: {
  path: string;
  crumbs: readonly BreadcrumbSegment[];
  onNavigateFolder: (relPath: string) => void;
  trailing?: React.ReactNode;
  /** The transient save-status indicator, sitting right beside the file name. */
  status?: React.ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-hairline px-4">
      <div className="flex min-w-0 items-center gap-1 text-xs" title={path}>
        {crumbs.map((segment, index) => (
          <span key={`${segment.kind}:${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && (
              <ChevronRight className="size-3 shrink-0 text-text-muted" strokeWidth={1.5} />
            )}
            {segment.kind === 'file' ? (
              // The document's name reads as a TITLE, not an identifier —
              // sans, not mono (feedback round 2).
              <span className="min-w-0 truncate font-medium text-text-primary">
                {segment.label}
              </span>
            ) : (
              // Folder crumbs only — no root crumb of any kind (take 3):
              // the topbar's mini-breadcrumb owns Home.
              <button
                type="button"
                onClick={() => onNavigateFolder(segment.relPath)}
                className="shrink-0 text-text-muted hover:text-text-primary"
              >
                {segment.label}
              </button>
            )}
          </span>
        ))}
      </div>
      {status}
      <span className="flex-1" />
      {trailing}
    </div>
  );
}

/**
 * Feedback round 2: saving is a moment, not a resident label. While the
 * debounced autosave is in flight (or an edit is waiting for it) a quiet
 * pulsing dot says "Saving…"; when it lands, a green dot says "Saved" for
 * a breath and then the header goes back to just the document's name.
 * (The wireframe's colored-circle grammar — the same dot the Cloud row
 * uses for "Backed up".)
 */
const SaveStatus = observer(function SaveStatus({ resource }: { resource: DocTabResource }) {
  const state = resource.saveState;
  const [justSaved, setJustSaved] = useState(false);
  const previous = useRef(state);
  useEffect(() => {
    if (previous.current !== 'saved' && state === 'saved') {
      setJustSaved(true);
      const timer = window.setTimeout(() => setJustSaved(false), 1600);
      previous.current = state;
      return () => window.clearTimeout(timer);
    }
    previous.current = state;
  }, [state]);

  if (state !== 'saved') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-2xs text-text-muted">
        <span className="bg-accent size-1.5 animate-pulse rounded-full" />
        Saving…
      </span>
    );
  }
  if (justSaved) {
    return (
      <span className="popover-in flex shrink-0 items-center gap-1.5 text-2xs text-text-muted">
        <span className="bg-success size-1.5 rounded-full" />
        Saved
      </span>
    );
  }
  return null;
});

/**
 * Markdown AND other editable text/code/config share this one pane —
 * investigated before this round: `DocTabResource` (`doc-file-sync.ts`)
 * and its backing `rpc.rig.files.read`/`.write` are entirely type-agnostic
 * already (plain string IO, no markdown parsing anywhere), so nothing
 * about the save/Saved-indicator flow needed to change. The only thing
 * that DOES change per type is the CM6 grammar (`language`, threaded to
 * `DocEditor`) and whether comments attach at all (`commentsEnabled`).
 *
 * `DocEditor` renders at its natural content height (`doc-editor-theme.ts`)
 * rather than filling and internally scrolling its own box, so this
 * component's own wrapper is the scroll container both the document and the
 * margin rail share — the coordinate space `MarginRail`'s anchor positioning
 * depends on.
 *
 * Wrapped in `observer()`: this reads `resource.isLoading`/`.loadError`/
 * `.saveState`/`.hasDiskUpdate` directly (mobx observables on `DocTabResource`,
 * flipped via `runInAction` after an async disk read). Without `observer()`
 * here, those reads aren't tracked and this pane never re-renders when the
 * load actually completes — it freezes on whatever was true the one or two
 * times something else happened to re-render it, which is exactly the "Saved
 * chrome shows, body stuck on Loading… forever" bug this fixed.
 */
const EditableArtifactPane = observer(function EditableArtifactPane({
  root,
  rootId,
  path,
  crumbs,
  language,
  commentsEnabled,
  showShare,
  isSkill,
  onNavigateFolder,
}: {
  root: string;
  rootId: string;
  path: string;
  crumbs: readonly BreadcrumbSegment[];
  language: EditorLanguage;
  commentsEnabled: boolean;
  showShare: boolean;
  /** File-navigator redesign: shows the "Skill · teaches your agents" banner below the header. */
  isSkill: boolean;
  onNavigateFolder: (relPath: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Feedback round 5: comments can step aside per document — Docs
  // grammar. Session-local, defaults shown; the anchors stay marked in the
  // text (they are document state), only the rail and the selection
  // affordance retire.
  const [showComments, setShowComments] = useState(true);

  // Built together, synchronously, so the comments decoration extension is
  // already in `extensionFactories` before `DocEditor`'s own mount effect
  // reads it — child effects run before parent effects, so registering the
  // extension from a parent `useEffect` (after `DocEditor` has already
  // constructed its CM6 state) would be one render too late.
  const { resource, comments } = useMemo(() => {
    const doc = new DocTabResource({ path }, { root, rootId });
    const store = commentsEnabled ? attachDocComments(doc) : null;
    if (store) {
      doc.extensionFactories.push(() =>
        commentDecorations(
          (id) => store.setActiveThread(id),
          (id) => store.setHoveredThread(id)
        )
      );
    }
    return { resource: doc, comments: store };
    // Recreated only when the open file actually changes — `key={path}` on
    // the grandparent (`App.tsx`'s `<ArtifactView key={nav.path} .../>`)
    // guarantees a remount rather than relying on this dependency array.
  }, [path, root, rootId, commentsEnabled]);

  useEffect(() => {
    return () => {
      if (comments) disposeDocComments(resource);
      resource.dispose();
    };
    // `comments` genuinely belongs here now (unlike the original, it can be
    // null) — but it only ever changes in lockstep with `resource` (both
    // come from the same `useMemo` above, recreated only on a full remount
    // per `key={path}`), so listing it doesn't change when this fires.
  }, [resource, comments]);

  // Visibility is its own effect, NOT folded into the dispose effect above
  // — toggling must never re-run that cleanup and tear down the resource.
  useEffect(() => {
    comments?.setVisible(showComments);
  }, [comments, showComments]);

  useEffect(() => {
    comments?.syncMarkers();
  }, [comments]);

  // Click-away dismisses the active thread — Docs behavior: the focused
  // comment "goes away" the moment you click anywhere that isn't its own
  // anchor, a margin card, or the composer. Capture-phase on `document` so a
  // descendant's `stopPropagation()` (several buttons in the rail call it)
  // can never hide a click from this. `setActiveThread(null)` never requests
  // a reveal (see its own doc comment) — this can never trigger a scroll, and
  // it never touches `composerQuote`, so an in-progress draft is untouched
  // regardless of what else is clicked.
  useEffect(() => {
    if (!comments) return;
    const handleClickAway = (event: MouseEvent) => {
      if (comments.activeThreadId === null) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // The anchor's own mark/dot already manages `activeThreadId` on its
      // own click (`onFocusThread` above) — never fight that here.
      if (target.closest('.cm-rigComment, .cm-rigCommentGlyph')) return;
      // Any margin card, or the composer — both live in the rail's subtree.
      if (target.closest('[data-comments-rail]')) return;
      comments.setActiveThread(null);
    };
    document.addEventListener('mousedown', handleClickAway, true);
    return () => document.removeEventListener('mousedown', handleClickAway, true);
  }, [comments]);

  const showMargin = comments !== null && showComments && shouldShowMargin(comments);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeaderBar
        path={path}
        crumbs={crumbs}
        onNavigateFolder={onNavigateFolder}
        status={<SaveStatus resource={resource} />}
        trailing={
          <>
            {resource.hasDiskUpdate && (
              <button
                type="button"
                onClick={() => void resource.reloadFromDisk()}
                title="This file changed on disk. Reload and discard your unsaved changes."
                className="rounded-chip border border-border-hairline px-2 py-0.5 text-xs text-text-muted hover:bg-bg-2 hover:text-text-primary"
              >
                Updated on disk · Reload
              </button>
            )}
            {comments && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setShowComments((v) => !v)}
                      aria-pressed={showComments}
                      aria-label={showComments ? 'Hide comments' : 'Show comments'}
                      className={cn(
                        'flex size-6 items-center justify-center rounded-control transition-colors',
                        showComments
                          ? 'bg-bg-2 text-text-primary'
                          : 'text-text-muted hover:bg-bg-2 hover:text-text-primary'
                      )}
                    >
                      <MessageSquare className="size-3.5" strokeWidth={1.5} />
                    </button>
                  }
                />
                <TooltipContent side="bottom">
                  {showComments ? 'Hide comments' : 'Show comments'}
                </TooltipContent>
              </Tooltip>
            )}
            {showShare && <ShareButton absPath={path} />}
          </>
        }
      />

      {isSkill && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline bg-bg-2 px-4 py-1.5 text-xs text-text-muted">
          <Sparkles className="size-3 shrink-0" strokeWidth={1.5} />
          <span>Skill · teaches your agents</span>
        </div>
      )}

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto">
        {resource.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Loading…
          </div>
        ) : resource.loadError ? (
          <div className="px-8 py-8 text-sm text-danger">
            Could not open document: {resource.loadError}
          </div>
        ) : (
          <>
            <DocEditor
              key={resource.path}
              ref={resource.editorRef}
              path={resource.path}
              initialContent={resource.content}
              language={language}
              onChange={resource.handleEditorChange}
              onSave={() => void resource.flush()}
              onSelectionChange={resource.handleSelectionChange}
              extraExtensions={resource.extensionFactories}
            />
            {showMargin && comments && (
              <MarginRail
                store={comments}
                containerRef={containerRef}
                getView={() => resource.editorRef.current?.getView() ?? null}
              />
            )}
            {comments && showComments && (
              <CommentSelectionButton resource={resource} store={comments} />
            )}
          </>
        )}
      </div>
    </div>
  );
});
