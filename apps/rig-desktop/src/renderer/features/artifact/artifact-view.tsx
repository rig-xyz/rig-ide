import {
  ChevronRight,
  Code as CodeIcon,
  Eye,
  GitMerge,
  Globe,
  Loader2,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import { getSearchQuery, openSearchPanel, SearchQuery, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { observer } from 'mobx-react-lite';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { commentDecorations } from '@renderer/features/docs/comments/comment-decorations';
import { CommentSelectionButton } from '@renderer/features/docs/comments/comment-selection';
import { CommentPins } from '@renderer/features/docs/comments/comment-pins';
import { MarginRail, shouldShowMargin } from '@renderer/features/docs/comments/comments-margin';
import { marginMode, PIN_GUTTER, RAIL_RESERVE, type MarginMode } from '@renderer/features/docs/comments/margin-layout';
import {
  attachDocComments,
  disposeDocComments,
} from '@renderer/features/docs/comments/comments-store';
import { useRigDocumentContext } from '@renderer/features/docs/context/use-rig-document-context';
import { DocEditor } from '@renderer/features/docs/doc-editor';
import { DocTabResource } from '@renderer/features/docs/doc-file-sync';
import { CommentCount, CommentModeControl, CommentModeStatus } from '@renderer/features/comment-mode/comment-mode-ui';
import { PaintbrushCursorChip } from '@renderer/features/docs/paintbrush/paintbrush-cursor-chip';
import { paintbrushDecorations } from '@renderer/features/docs/paintbrush/paintbrush-decorations';
import { usePaintbrushEditorSync } from '@renderer/features/docs/paintbrush/use-paintbrush-editor-sync';
import { usePaintbrushMode } from '@renderer/features/docs/paintbrush/use-paintbrush';
import { PaintbrushPreviewSweep } from '@renderer/features/docs/paintbrush/paintbrush-preview-sweep';
import { PreviewCommentSelectionButton } from '@renderer/features/docs/preview/preview-comment-selection';
import { ReadingFindBar, type ReadingFind } from '@renderer/features/docs/preview/reading-find-bar';
import { usePreviewComments } from '@renderer/features/docs/preview/use-preview-comments';
import { PageView } from '@renderer/features/pages/page-view';
import { cmdFTarget, CmdFRouteContext, focusOf, isCmdF } from '@renderer/features/shell/cmd-f-target';
import { archiveEntry } from '@renderer/features/workspace/file-actions';
import { requestOpenFile } from '@renderer/features/workspace/open-file-request';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { conflictCopyOriginal } from '@shared/rig/conflict-copies';
import { classifyEntryCategory, relPathFromRoot } from '@shared/rig/file-navigator-categories';
import { rigFileUrl } from '@shared/spaces/rig-file';
import { breadcrumbSegments, type BreadcrumbSegment } from './breadcrumb';
import type { EditorLanguage } from './file-type';
import { ImageArtifact } from './image-artifact';
import { PdfArtifact } from './pdf-artifact';
import { getPreviewMode, rememberedPreviewMode, setPreviewMode, type PreviewMode } from './preview-mode-memory';
import { PreviewPane, type PreviewHandle } from './preview-pane';
import { FileOptionsButton } from './file-options-menu';
import { ShareButton } from './share-popover';
import { UnsupportedArtifact } from './unsupported-artifact';
import { useFileType } from './use-file-type';
import { requestView, useViewRequest, type ViewRequest } from './view-request';

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
  bindingId,
  onNavigateFolder,
}: {
  /** The bound rig's workspace root — scopes the file watcher. */
  root: string;
  rootId: string;
  /** Absolute path of the file being viewed. */
  path: string;
  /** The rig's binding, for the title bar menu's Pin to top. */
  bindingId?: string | null;
  /** Open the navigator revealing this folder — folder breadcrumb segments. (Feedback round 5: the Files button itself lives on the tab strip now, one level up; closing is the tab's ×.) */
  onNavigateFolder: (relPath: string) => void;
}) {
  const fileInfo = useFileType(root, rootId, path);
  // The `⋯` file menu, for any file inside the rig.
  const fileOptions = path.startsWith(`${root}/`) ? (
    <FileOptionsButton root={root} rootId={rootId} bindingId={bindingId} absPath={path} />
  ) : null;
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
  const conflictBanner = <ConflictCopyBanner root={root} rootId={rootId} path={path} />;

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
        fileOptions={fileOptions}
        banner={conflictBanner}
        bindingId={bindingId ?? null}
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeaderBar
        path={path}
        crumbs={crumbs}
        onNavigateFolder={onNavigateFolder}
        titleAction={fileOptions}
      />
      {conflictBanner}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {type === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
            Loading…
          </div>
        ) : type.category === 'image' ? (
          <ImageArtifact root={root} rootId={rootId} path={path} mime={type.mime} />
        ) : type.category === 'pdf' ? (
          <PdfArtifact root={root} rootId={rootId} path={path} />
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
 * A conflict copy (`shared/rig/conflict-copies.ts`) opened from its file's
 * menu: a quiet line under the title bar says what it is and what to do
 * with it, with the file it came from one click away. Nothing for any
 * other file.
 */
function ConflictCopyBanner({ root, rootId, path }: { root: string; rootId: string; path: string }) {
  const relPath = relPathFromRoot(root, path);
  const original = relPath === path ? null : conflictCopyOriginal(relPath);
  if (!original) return null;
  const name = original.split('/').pop() ?? original;
  const chip =
    'border-border-hairline bg-bg-0 hover:text-text-primary shrink-0 rounded-chip border px-2 py-0.5 text-xs text-text-secondary transition-colors';
  return (
    <div
      className="border-border-hairline bg-bg-2 flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs text-text-secondary"
      data-testid="conflict-copy-banner"
    >
      <GitMerge className="size-3 shrink-0 text-warning" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        This is a version of yours that didn’t make it into {name}. Copy what you need into it, then archive this one.
      </span>
      <button type="button" className={chip} onClick={() => requestOpenFile(`${root}/${original}`)}>
        Open {name}
      </button>
      <button type="button" className={chip} onClick={() => void archiveEntry(root, rootId, relPath)}>
        Archive this version
      </button>
    </div>
  );
}

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
  titleAction,
}: {
  path: string;
  crumbs: readonly BreadcrumbSegment[];
  onNavigateFolder: (relPath: string) => void;
  trailing?: React.ReactNode;
  /** Beside the file's name: its Share button and options menu. */
  titleAction?: React.ReactNode;
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
      {titleAction}
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
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
        Saving…
      </span>
    );
  }
  if (justSaved) {
    return (
      <span className="popover-in flex shrink-0 items-center gap-1.5 text-2xs text-text-muted">
        <span className="size-1.5 rounded-full bg-success" />
        Saved
      </span>
    );
  }
  return null;
});

/**
 * Preview ⇄ Edit segmented toggle (`preview-mode-spec.md` "Shape") —
 * markdown-only, rendered by `EditableArtifactPane` only when `language ===
 * 'markdown'`. Same segmented-icon-toggle grammar as the topbar's
 * `LayoutSwitcher` (`features/shell/layout-switcher.tsx`): a
 * `radiogroup`/`radio` pair that rests on the current mode's icon and opens
 * on hover, rather than inventing a second toggle visual language.
 */
const MODE_SEGMENTS: Record<PreviewMode, { label: string; Icon: typeof Eye }> = {
  preview: { label: 'Preview', Icon: Eye },
  browser: { label: 'Browser', Icon: Globe },
  edit: { label: 'Edit', Icon: CodeIcon },
};

function PreviewModeToggle({
  mode,
  modes,
  onChange,
}: {
  mode: PreviewMode;
  /** The modes this file has, in order: Preview and Edit for markdown, Browser and Edit for html. */
  modes: readonly PreviewMode[];
  onChange: (next: PreviewMode) => void;
}) {
  const segments = modes.map((value) => ({ value, ...MODE_SEGMENTS[value] }));
  // Same treatment as the top bar's layout switch: at rest just the current
  // mode's icon, no frame; the other slides out on its left on hover or
  // keyboard focus, and the current one never moves.
  const ordered = [...segments.filter((s) => s.value !== mode), ...segments.filter((s) => s.value === mode)];
  return (
    <div
      role="radiogroup"
      aria-label="View mode"
      className="group flex items-center rounded-control border border-transparent p-0.5 transition-colors duration-200 hover:border-border-hairline hover:bg-bg-1 has-[:focus-visible]:border-border-hairline has-[:focus-visible]:bg-bg-1"
    >
      {ordered.map(({ value, label, Icon }) => {
        const selected = mode === value;
        return (
          <span
            key={value}
            className={cn(
              'flex shrink-0 transition-[max-width,opacity,margin] duration-200 ease-out motion-reduce:transition-none',
              selected
                ? 'max-w-7'
                : 'max-w-0 overflow-hidden opacity-0 group-hover:mr-0.5 group-hover:max-w-7 group-hover:opacity-100 group-has-[:focus-visible]:mr-0.5 group-has-[:focus-visible]:max-w-7 group-has-[:focus-visible]:opacity-100'
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    onClick={() => onChange(value)}
                    className={cn(
                      'flex h-6 w-7 items-center justify-center rounded-control transition-colors',
                      selected
                        ? 'text-text-primary group-hover:bg-bg-2 group-has-[:focus-visible]:bg-bg-2'
                        : 'text-text-muted hover:bg-bg-2/60 hover:text-text-primary'
                    )}
                  >
                    <Icon className="size-3.5" strokeWidth={1.5} />
                  </button>
                }
              />
              <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
          </span>
        );
      })}
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
  rootId,
  path,
  crumbs,
  language,
  commentsEnabled,
  showShare,
  isSkill,
  onNavigateFolder,
  fileOptions,
  banner,
  bindingId,
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
  /** The title bar's `⋯` file menu, after Share. */
  fileOptions: React.ReactNode;
  /** A line under the title bar (a conflict copy's). */
  banner?: React.ReactNode;
  /** The space or rig the file is in: an html file opens in Browser mode through it. */
  bindingId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  // Feedback round 5: comments can step aside per document — Docs
  // grammar. Session-local, defaults shown; the anchors stay marked in the
  // text (they are document state), only the rail and the selection
  // affordance retire.
  const [showComments, setShowComments] = useState(true);
  // The header's "N resolved" chip (canvas board 17): resolved threads' pins and cards.
  const [showResolved, setShowResolved] = useState(false);

  // Comment mode (canvas board 16; the paintbrush, `docs/document-focus-
  // design.md` §2): the header's Comment control and who it's addressed to —
  // markdown-only (`isMarkdown` below gates where the control renders and
  // where selection release opens the composer), same as comments themselves.
  const paintbrush = usePaintbrushMode();

  // Preview ⇄ Edit (`preview-mode-spec.md` "Shape"): markdown-only, Preview
  // by default, remembered per file for the session via `preview-mode-memory`.
  // A non-markdown text/code/config file never leaves Edit — the toggle
  // itself is hidden below, and this initializer never consults the memory
  // module for one, so its render path stays byte-for-byte what it was
  // before this file existed.
  const isMarkdown = language === 'markdown';
  // An html file in a space or synced rig is seen as a working page:
  // Browser, with Edit one click away. It opens in Browser however it was
  // opened, unless Edit was chosen for it this session.
  const relPath = relPathFromRoot(root, path);
  const browserUrl = language === 'html' && bindingId && relPath ? rigFileUrl(bindingId, relPath) : null;
  const modes: readonly PreviewMode[] = isMarkdown ? ['preview', 'edit'] : browserUrl ? ['browser', 'edit'] : ['edit'];
  const [mode, setModeState] = useState<PreviewMode>(() => {
    if (isMarkdown) return getPreviewMode(path);
    const remembered = rememberedPreviewMode(path);
    if (remembered && modes.includes(remembered)) return remembered;
    return browserUrl ? 'browser' : 'edit';
  });
  // Scroll position survives a toggle only approximately (spec's own
  // wording): captured as a fraction of the scrollable range right before
  // the mode flips, then reapplied once the new pane has laid out. A ratio,
  // not a pixel offset, because Preview and Edit almost never agree on
  // total document height.
  const pendingScrollRatio = useRef<number | null>(null);

  // Find (Cmd-F): CodeMirror's own panel while editing, `ReadingFindBar`
  // while reading. Switching between them with find open keeps the query.
  const [readingFind, setReadingFindState] = useState<ReadingFind | null>(null);
  // Closed, it keeps what was typed for the next Cmd-F, as the editor's does.
  const lastReadingFind = useRef<ReadingFind | null>(null);
  const setReadingFind = useCallback((next: ReadingFind | null) => {
    if (next) lastReadingFind.current = next;
    setReadingFindState(next);
  }, []);
  const carryToEditor = useRef<{ query: string; caseSensitive: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const ratio = pendingScrollRatio.current;
    if (!el || ratio === null) return;
    pendingScrollRatio.current = null;
    const scrollable = el.scrollHeight - el.clientHeight;
    el.scrollTop = scrollable > 0 ? ratio * scrollable : 0;
  }, [mode]);

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
      // Paintbrush's own independent decoration layer (`docs/document-focus-
      // design.md` §2) — deliberately a SEPARATE extension from
      // `commentDecorations` above, painting nothing until
      // `usePaintbrushEditorSync` below ever dispatches an overlay.
      doc.extensionFactories.push(() => paintbrushDecorations());
    }
    return { resource: doc, comments: store };
    // Recreated only when the open file actually changes — `key={path}` on
    // the grandparent (`App.tsx`'s `<ArtifactView key={nav.path} .../>`)
    // guarantees a remount rather than relying on this dependency array.
  }, [path, root, rootId, commentsEnabled]);

  const setMode = useCallback(
    (next: PreviewMode) => {
      const el = containerRef.current;
      if (el) {
        const scrollable = el.scrollHeight - el.clientHeight;
        pendingScrollRatio.current = scrollable > 0 ? el.scrollTop / scrollable : 0;
      }
      const view = resource.editorRef.current?.getView() ?? null;
      if (next === 'edit' && readingFind) {
        carryToEditor.current = { query: readingFind.query, caseSensitive: readingFind.caseSensitive };
        setReadingFind(null);
      } else if (next === 'preview' && view && searchPanelOpen(view.state)) {
        const query = getSearchQuery(view.state);
        setReadingFind({ query: query.search, caseSensitive: query.caseSensitive, focusNonce: Date.now() });
      }
      setPreviewMode(path, next);
      setModeState(next);
    },
    [path, resource, readingFind, setReadingFind]
  );

  // An agent or a chat link asked for a mode, a passage or a line
  // (`view-request.ts`). A line is only in the text, so it opens Edit.
  const [reveal, setReveal] = useState<(ViewRequest & { at: number }) | null>(null);
  useViewRequest(path, (request) => {
    const wanted = request.line ? 'edit' : request.mode;
    if (wanted && modes.includes(wanted) && wanted !== mode) setMode(wanted);
    setReveal({ ...request, at: Date.now() });
  });
  useEffect(() => {
    if (!reveal || resource.isLoading) return;
    if (mode === 'browser') {
      if (reveal.passage && browserUrl) requestView(browserUrl, { passage: reveal.passage });
      setReveal(null);
      return;
    }
    if (mode === 'preview') {
      if (reveal.passage) setReadingFind({ query: reveal.passage, caseSensitive: false, focusNonce: reveal.at });
      setReveal(null);
      return;
    }
    const view = resource.editorRef.current?.getView();
    if (!view) return;
    const doc = view.state.doc;
    let at: number | null = null;
    if (reveal.line) at = doc.line(Math.min(reveal.line, doc.lines)).from;
    else if (reveal.passage) {
      const found = doc.toString().toLowerCase().indexOf(reveal.passage.toLowerCase());
      if (found !== -1) at = found;
    }
    if (at !== null) {
      const end = reveal.passage && !reveal.line ? at + reveal.passage.length : at;
      view.dispatch({ selection: { anchor: at, head: end }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    }
    setReveal(null);
  }, [reveal, mode, resource, resource.isLoading, browserUrl, setReadingFind]);

  // Browser mode follows the file: an agent writing it reloads the page.
  const [pageReload, setPageReload] = useState(0);
  const shownContent = useRef<string | null>(null);
  const liveContent = resource.isLoading ? null : resource.content;
  useEffect(() => {
    if (mode !== 'browser' || liveContent === null) return;
    if (shownContent.current === null) {
      shownContent.current = liveContent;
      return;
    }
    if (shownContent.current === liveContent) return;
    const timer = setTimeout(() => {
      shownContent.current = liveContent;
      setPageReload((n) => n + 1);
    }, 400);
    return () => clearTimeout(timer);
  }, [mode, liveContent]);

  // Reading → editing with find open: CodeMirror's panel opens on the same
  // query (the fresh editor has mounted by now: child effects run first).
  useEffect(() => {
    const carried = carryToEditor.current;
    if (mode !== 'edit' || !carried) return;
    carryToEditor.current = null;
    const view = resource.editorRef.current?.getView();
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: carried.query, caseSensitive: carried.caseSensitive })) });
    openSearchPanel(view);
  }, [mode, resource]);

  // Cmd-F finds in this doc when it's the pane you're in (`cmd-f-target.ts`),
  // the chat's search otherwise. In the editor CodeMirror's own keymap
  // answers first; from elsewhere in the pane it focuses the editor and
  // opens the same panel. On its own, outside App, the doc is the only pane.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const getCmdFRoute = useContext(CmdFRouteContext);
  const findTarget = useCallback(
    (event: KeyboardEvent) => {
      const route = getCmdFRoute?.() ?? { layout: 'files' as const, lastPane: 'artifact' as const };
      const target = event.target instanceof Element ? event.target : null;
      return cmdFTarget({
        ...route,
        focus: focusOf(event.target, { root: paneRef.current, pane: 'artifact' }),
        editorFocused: target?.closest('.cm-editor') != null,
        previewOpen: mode === 'preview',
      });
    },
    [getCmdFRoute, mode]
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isCmdF(event)) return;
      const target = findTarget(event);
      if (target === 'doc-reading') {
        event.preventDefault();
        const last = lastReadingFind.current;
        setReadingFind({
          query: last?.query ?? '',
          caseSensitive: last?.caseSensitive ?? false,
          focusNonce: (last?.focusNonce ?? 0) + 1,
        });
      } else if (target === 'doc-editor') {
        const view = resource.editorRef.current?.getView();
        if (!view) return;
        event.preventDefault();
        view.focus();
        openSearchPanel(view);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [findTarget, resource, setReadingFind]);
  // Esc closes the reading view's find from the doc (the field closes it
  // itself), before the pane's own Esc closes the tab.
  const readingFindOpen = readingFind !== null && mode === 'preview';
  useEffect(() => {
    if (!readingFindOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (findTarget(event) !== 'doc-reading') return;
      event.preventDefault();
      setReadingFind(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [readingFindOpen, findTarget, setReadingFind]);
  const getPreviewRoot = useCallback(() => previewRef.current?.getRoot() ?? null, []);

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

  // `mode` belongs in the deps: toggling Preview ⇄ Edit unmounts and
  // remounts `DocEditor`, and the fresh EditorView has no markers until
  // someone paints them — without this, a comment's highlight and margin
  // card only reappeared on the next content change. Child effects run
  // before parent effects, so by the time this fires on an Edit remount the
  // view is already mounted; firing on a Preview flip is a no-op
  // (`_paintMarkers` bails when there's no view).
  useEffect(() => {
    comments?.syncMarkers();
  }, [comments, mode]);

  // Comments layer wiring for Preview mode (`preview-mode-spec.md` rollout
  // step 3): registers the Preview surface adapter on the store, paints
  // open threads' anchors via the CSS Custom Highlight API, and hit-tests
  // clicks/hover — the Preview-mode counterpart to `commentDecorations`'s
  // CM6 event handlers above. `active` is false in Edit mode (or with
  // comments off), so this never contends with CM6 for the store's surface.
  usePreviewComments({
    active: mode === 'preview' && comments !== null && showComments,
    getRoot: () => previewRef.current?.getRoot() ?? null,
    getIndex: () => previewRef.current?.getIndex() ?? null,
    sourceLength: resource.content.length,
    store: comments,
  });

  // Paintbrush overlay wiring. The paintbrush paints no tint of its own (the
  // comments layer already marks the passage); its only paint is the
  // streaming sweep — a CM6 mark in Edit mode (`usePaintbrushEditorSync`),
  // rectangles behind the text in Preview (`PaintbrushPreviewSweep`, in the
  // JSX below). `comments.paintbrushOverlay` is null whenever there's
  // nothing to track, so both are inert until a stroke actually happens.
  const paintbrushOverlay = comments?.paintbrushOverlay ?? null;
  // Browser mode shows no text of its own: to these, it reads like Preview with nothing in it.
  const textMode = mode === 'browser' ? 'preview' : mode;
  usePaintbrushEditorSync(resource, textMode, paintbrushOverlay);

  // Cursor affordance while armed (punch-list finding 3): the document
  // keeps its plain native text cursor — no CSS override in either mode —
  // and a small tinted orb chip tracks the pointer instead, faded out
  // while the composer is open (nothing useful to arm against once a
  // stroke is already being typed).
  const paintbrushComposerOpen = comments?.composerQuote != null;

  // Esc leaves comment mode (a draft in progress keeps it: Esc there is the
  // composer's). Capture phase, and marked used, so the panel's own Esc
  // (close the tab) waits for the next one.
  const setCommentMode = paintbrush.setOn;
  useEffect(() => {
    if (!paintbrush.on) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || comments?.composerQuote != null) return;
      setCommentMode(false);
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [paintbrush.on, comments, setCommentMode]);

  // Prompt-scoped provenance target: the chat panel is a sibling, so this
  // hook publishes only the main-validated locator for the active document
  // and its latest Edit/Preview selection. No document text crosses that
  // boundary, and an unavailable target never blocks chat submission.
  useRigDocumentContext({
    root,
    rootId,
    resource,
    mode: textMode,
    getPreviewRoot: () => previewRef.current?.getRoot() ?? null,
    getPreviewIndex: () => previewRef.current?.getIndex() ?? null,
  });

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
      if (target.closest('.cm-rigComment, [data-comment-pin]')) return;
      // Any margin card, or the composer — both live in the rail's subtree.
      if (target.closest('[data-comments-rail]')) return;
      // Preview's highlights are painted via the CSS Custom Highlight API —
      // no DOM element to `closest()` against. `usePreviewComments`'s own
      // click handler is the sole authority for clicks inside the preview
      // document (it sets or clears the active thread itself); this
      // click-away must not race it.
      const previewRoot = previewRef.current?.getRoot();
      if (previewRoot?.contains(target)) return;
      comments.setActiveThread(null);
    };
    document.addEventListener('mousedown', handleClickAway, true);
    return () => document.removeEventListener('mousedown', handleClickAway, true);
  }, [comments]);

  // The margin rail now renders in both modes (`preview-mode-spec.md`
  // rollout step 3) — `MarginRail` itself reads whichever surface adapter
  // is currently registered (`store.surface`) for card y-positions, CM6 in
  // Edit and the Preview surface adapter in Preview (`usePreviewComments`
  // above). The store keeps running underneath regardless of mode (polling,
  // `_reanchor`, …) — only the painted UI steps aside, same as it already
  // does for `showComments`.
  const showMargin = comments !== null && showComments && shouldShowMargin(comments);
  // A real margin beside the text when the panel has room for one, pins only
  // when it doesn't (`marginMode`). With room, the text column always gives
  // the margin its space while comments are on, even before there are any,
  // so opening a draft never moves the text out from under the selection.
  const margin = useMarginMode(containerRef);
  const commentsOn = isMarkdown && comments !== null && showComments;
  const openCount = comments !== null && showComments ? comments.visibleThreads.length : 0;
  const resolvedCount = comments !== null && showComments ? comments.visibleResolvedThreads.length : 0;

  return (
    <div ref={paneRef} className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeaderBar
        path={path}
        crumbs={crumbs}
        onNavigateFolder={onNavigateFolder}
        status={<SaveStatus resource={resource} />}
        titleAction={
          <>
            {showShare && <ShareButton absPath={path} />}
            {fileOptions}
          </>
        }
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
            {isMarkdown && comments && (
              <CommentModeControl
                on={paintbrush.on}
                toggle={paintbrush.toggle}
                who={paintbrush.selected}
                agents={paintbrush.agents}
                pick={paintbrush.pick}
                count={
                  <CommentCount
                    open={openCount}
                    resolved={resolvedCount}
                    showResolved={showResolved}
                    onToggleResolved={() => setShowResolved((v) => !v)}
                  />
                }
                testId="doc-comment-mode"
              />
            )}
            {modes.length > 1 && <PreviewModeToggle mode={mode} modes={modes} onChange={setMode} />}
            {/* Hidden in Preview along with the margin/composer it controls
                — a toggle for UI that isn't rendered has nothing to do. */}
            {comments && mode === 'edit' && (
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
          </>
        }
      />

      {isSkill && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline bg-bg-2 px-4 py-1.5 text-xs text-text-muted">
          <Sparkles className="size-3 shrink-0" strokeWidth={1.5} />
          <span>Skill · teaches your agents</span>
        </div>
      )}
      {banner}

      {readingFindOpen && !resource.isLoading && !resource.loadError && (
        <ReadingFindBar
          find={readingFind}
          onChange={setReadingFind}
          onClose={() => setReadingFind(null)}
          content={resource.content}
          getRoot={getPreviewRoot}
          scrollerRef={containerRef}
        />
      )}

      {mode === 'browser' && browserUrl ? (
        // The page itself, from this Mac's copy of the space, with the space's pins on it.
        <div className="relative min-h-0 flex-1" data-testid="doc-browser-mode">
          <PageView url={browserUrl} title={relPath.split('/').pop() ?? relPath} bindingId={bindingId!} reloadKey={pageReload} />
        </div>
      ) : (
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        style={
          commentsOn
            ? { paddingLeft: PIN_GUTTER, ...(margin === 'rail' ? { paddingRight: RAIL_RESERVE } : {}) }
            : undefined
        }
      >
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
            {mode === 'preview' ? (
              // Only reachable for markdown — the initializer above never
              // sets `mode` to `'preview'` for anything else. Reads
              // `resource.content` directly — the same observable
              // DocEditor writes on every keystroke and `_absorb` writes on
              // every external (agent/disk) edit, so this re-renders live
              // whether the change came from typing before the toggle or
              // from an agent writing mid-read. No CM6 involved: Preview is
              // read-only, so there's nothing here for `resource.editorRef`
              // to point at.
              <PreviewPane ref={previewRef} content={resource.content} />
            ) : (
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
            )}
            {comments && showComments && (
              <CommentPins store={comments} containerRef={containerRef} showResolved={showResolved} />
            )}
            {showMargin && comments && (
              <MarginRail
                store={comments}
                containerRef={containerRef}
                mode={margin}
                showResolved={showResolved}
                onShowResolved={setShowResolved}
              />
            )}
            {mode === 'edit' && comments && showComments && (
              <CommentSelectionButton
                resource={resource}
                store={comments}
                paintbrush={{ on: paintbrush.on, mention: paintbrush.mention, agents: paintbrush.agents }}
              />
            )}
            {mode === 'preview' && comments && (
              <PaintbrushPreviewSweep
                active={mode === 'preview'}
                getRoot={() => previewRef.current?.getRoot() ?? null}
                getIndex={() => previewRef.current?.getIndex() ?? null}
                overlay={paintbrushOverlay}
              />
            )}
            {mode === 'preview' && comments && showComments && (
              <PreviewCommentSelectionButton
                getRoot={() => previewRef.current?.getRoot() ?? null}
                getIndex={() => previewRef.current?.getIndex() ?? null}
                content={resource.content}
                store={comments}
                paintbrush={{ on: paintbrush.on, mention: paintbrush.mention, agents: paintbrush.agents }}
              />
            )}
          </>
        )}
      </div>
      )}
      {isMarkdown && comments && (
        <PaintbrushCursorChip
          active={paintbrush.on && !paintbrushComposerOpen}
          containerRef={containerRef}
          who={paintbrush.selected}
        />
      )}
      {isMarkdown && paintbrush.on && !paintbrushComposerOpen && <CommentModeStatus who={paintbrush.selected} onLeave={() => paintbrush.setOn(false)} />}
    </div>
  );
});

/** The file panel's margin mode, following its width (`marginMode`). */
function useMarginMode(containerRef: React.RefObject<HTMLDivElement | null>): MarginMode {
  const [mode, setMode] = useState<MarginMode>('rail');
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // The panel's full width, padding included: the reserve itself must not flip the mode back.
    const measure = () => setMode(marginMode(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);
  return mode;
}
