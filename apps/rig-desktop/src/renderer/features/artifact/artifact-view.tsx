import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef } from 'react';
import { CommentSelectionButton } from '@renderer/features/docs/comments/comment-selection';
import { commentDecorations } from '@renderer/features/docs/comments/comment-decorations';
import { attachDocComments, disposeDocComments } from '@renderer/features/docs/comments/comments-store';
import { MarginRail, shouldShowMargin } from '@renderer/features/docs/comments/comments-margin';
import { DocEditor } from '@renderer/features/docs/doc-editor';
import { DocTabResource } from '@renderer/features/docs/doc-file-sync';
import { cn } from '@renderer/lib/utils';
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
  path,
  onClose,
  onNavigateFolder,
}: {
  /** The bound rig's workspace root — scopes the file watcher. */
  root: string;
  /** Absolute path of the file being viewed. */
  path: string;
  /** Plain pop, no target — the header's Back button. */
  onClose: () => void;
  /** Pop to the navigator AND reveal this folder (relPath) — folder breadcrumb segments. */
  onNavigateFolder: (relPath: string) => void;
}) {
  const fileInfo = useFileType(path);
  const crumbs = useMemo(() => breadcrumbSegments(root, path), [root, path]);
  const type = fileInfo?.type ?? null;

  if (type !== null && (type.category === 'markdown' || type.category === 'text')) {
    return (
      <EditableArtifactPane
        root={root}
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
        onClose={onClose}
        onNavigateFolder={onNavigateFolder}
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeaderBar path={path} crumbs={crumbs} onClose={onClose} onNavigateFolder={onNavigateFolder} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {type === null ? (
          <div className="text-text-muted flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
            Loading…
          </div>
        ) : type.category === 'image' ? (
          <ImageArtifact path={path} mime={type.mime} />
        ) : (
          <UnsupportedArtifact path={path} size={fileInfo?.size ?? null} />
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
  onClose,
  onNavigateFolder,
  trailing,
}: {
  path: string;
  crumbs: readonly BreadcrumbSegment[];
  onClose: () => void;
  onNavigateFolder: (relPath: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="border-border-hairline flex h-10 shrink-0 items-center gap-2 border-b px-4">
      {/* Real button chrome (round 14): outlined ghost, radius 6, so this
          reads as a control you press — distinct from the breadcrumb path
          you read, which starts fresh after the gap below. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Back to files"
        className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex shrink-0 items-center gap-1 border bg-transparent px-2 py-1 text-xs transition-colors"
      >
        <ChevronLeft className="size-3.5" strokeWidth={1.5} />
        Back
      </button>
      <div className="flex min-w-0 items-center gap-1 text-xs" title={path}>
        {crumbs.map((segment, index) => (
          <span key={`${segment.kind}:${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="text-text-muted size-3 shrink-0" strokeWidth={1.5} />}
            {segment.kind === 'file' ? (
              <span className="text-text-primary min-w-0 truncate font-mono">{segment.label}</span>
            ) : (
              // Folder crumbs only — no root crumb of any kind (take 3):
              // the topbar's mini-breadcrumb owns Home, and the Back
              // button beside this path is the way to the navigator.
              <button
                type="button"
                onClick={() => onNavigateFolder(segment.relPath)}
                className="text-text-muted hover:text-text-primary shrink-0"
              >
                {segment.label}
              </button>
            )}
          </span>
        ))}
      </div>
      {trailing}
    </div>
  );
}

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
  path,
  crumbs,
  language,
  commentsEnabled,
  showShare,
  onClose,
  onNavigateFolder,
}: {
  root: string;
  path: string;
  crumbs: readonly BreadcrumbSegment[];
  language: EditorLanguage;
  commentsEnabled: boolean;
  showShare: boolean;
  onClose: () => void;
  onNavigateFolder: (relPath: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Built together, synchronously, so the comments decoration extension is
  // already in `extensionFactories` before `DocEditor`'s own mount effect
  // reads it — child effects run before parent effects, so registering the
  // extension from a parent `useEffect` (after `DocEditor` has already
  // constructed its CM6 state) would be one render too late.
  const { resource, comments } = useMemo(() => {
    const doc = new DocTabResource({ path }, { root });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, root, commentsEnabled]);

  useEffect(() => {
    comments?.setVisible(true);
    return () => {
      if (comments) disposeDocComments(resource);
      resource.dispose();
    };
    // `comments` genuinely belongs here now (unlike the original, it can be
    // null) — but it only ever changes in lockstep with `resource` (both
    // come from the same `useMemo` above, recreated only on a full remount
    // per `key={path}`), so listing it doesn't change when this fires.
  }, [resource, comments]);

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

  const showMargin = comments !== null && shouldShowMargin(comments);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeaderBar
        path={path}
        crumbs={crumbs}
        onClose={onClose}
        onNavigateFolder={onNavigateFolder}
        trailing={
          <>
            {resource.hasDiskUpdate && (
              <button
                type="button"
                onClick={() => void resource.reloadFromDisk()}
                title="This file changed on disk. Reload and discard your unsaved changes."
                className="border-border-hairline text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-chip border px-2 py-0.5 text-xs"
              >
                Updated on disk · Reload
              </button>
            )}
            {showShare && <ShareButton absPath={path} className="ml-auto" />}
            {/* When Share is hidden (non-markdown), the Saved indicator takes the `ml-auto` Share would otherwise own, so it still sits flush right. */}
            <span className={cn('text-text-muted shrink-0 text-xs', !showShare && 'ml-auto')}>
              {resource.saveState === 'saved'
                ? 'Saved'
                : resource.saveState === 'saving'
                  ? 'Saving…'
                  : 'Unsaved'}
            </span>
          </>
        }
      />

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto">
        {resource.isLoading ? (
          <div className="text-text-muted flex h-full items-center justify-center text-sm">
            Loading…
          </div>
        ) : resource.loadError ? (
          <div className="text-danger px-8 py-8 text-sm">
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
            {comments && <CommentSelectionButton resource={resource} store={comments} />}
          </>
        )}
      </div>
    </div>
  );
});
