import type { FileChange } from '@emdash/core/files';
import { action, makeObservable, observable, runInAction } from 'mobx';
import type { TabHandle, TabResource } from '@renderer/features/tabs/core/tab-provider';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import type { DocEditorHandle, DocSelection } from './doc-editor';
import type { DocExtensionFactory } from './doc-extensions';

/**
 * Disk plumbing for one open doc tab: initial read, debounced autosave, and
 * live absorption of edits made by anything else (agents, git, another editor).
 *
 * OWN-SAVE SUPPRESSION
 * Every time we learn what is on disk (after a successful write, after an
 * absorb, after the initial read) we record a signature of that content in
 * `_diskSignature`. The file watcher fires for our own writes too, so on every
 * event we re-read the file and drop it when its signature matches — no event
 * ordering assumptions, and correct for atomic saves that arrive as
 * create/delete pairs rather than a single 'update'.
 */

export type DocSaveState = 'saved' | 'saving' | 'unsaved';
export type DocViewMode = 'source' | 'preview';

/** Serializable per-tab state. Kept to just the absolute path. */
export interface DocPayload {
  path: string;
}

export interface DocContext {
  projectId: string;
  workspaceId: string;
}

const AUTOSAVE_DEBOUNCE_MS = 800;
const MAX_DOC_BYTES = 2 * 1024 * 1024;

/**
 * Cheap length-qualified content signature (djb2). Used only to recognize
 * content we already know about, never as a correctness guarantee: a collision
 * costs us one skipped absorb, not data.
 */
export function contentSignature(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return `${content.length}:${hash}`;
}

function describeError(error: { message?: string; type?: string }): string {
  return error.message ?? error.type ?? 'Unknown error';
}

type DiskRead = { content: string } | { error: string };

export class DocTabResource implements TabResource {
  readonly path: string;
  readonly projectId: string;
  readonly workspaceId: string;

  /**
   * Per-tab CM6 extension factories, applied after the globally registered
   * ones. Push before the editor mounts; they are read once at mount.
   */
  readonly extensionFactories: DocExtensionFactory[] = [];

  /**
   * Populated by the mounted DocEditor (via `useImperativeHandle`) and cleared
   * on unmount. The only channel through which this store talks to CM6.
   */
  readonly editorRef: { current: DocEditorHandle | null } = { current: null };

  /** Current buffer contents — mirrors CM6 and backs the preview. */
  content = '';
  isLoading = true;
  loadError: string | null = null;
  saveState: DocSaveState = 'saved';
  viewMode: DocViewMode = 'source';
  /** Disk moved while the buffer was dirty. Surfaced as a non-modal reload pill. */
  hasDiskUpdate = false;

  private readonly _handle: TabHandle | null;
  private readonly _unwatch: () => void;
  private readonly _selectionListeners = new Set<(selection: DocSelection) => void>();
  private _saveTimer: number | null = null;
  private _diskSignature: string | null = null;
  private _writeInFlight = false;
  private _isClosed = false;

  constructor(payload: DocPayload, ctx: DocContext, handle?: TabHandle) {
    this.path = payload.path;
    this.projectId = ctx.projectId;
    this.workspaceId = ctx.workspaceId;
    this._handle = handle ?? null;

    makeObservable(this, {
      content: observable,
      isLoading: observable,
      loadError: observable,
      saveState: observable,
      viewMode: observable,
      hasDiskUpdate: observable,
      handleEditorChange: action.bound,
      setViewMode: action.bound,
      dismissDiskUpdate: action.bound,
    });

    this._unwatch = events.on(fileChangesChannel, ({ workspaceId, update }) => {
      if (workspaceId !== this.workspaceId) return;
      if (update.kind === 'resync') {
        void this._syncFromDisk();
        return;
      }
      // Match on path only: atomic saves surface as create/delete pairs, so the
      // change kind carries no useful signal here.
      if (update.changes.some((change: FileChange) => change.path === this.path)) {
        void this._syncFromDisk();
      }
    });

    void this._loadInitial();
  }

  get basename(): string {
    return this.path.split('/').pop() ?? this.path;
  }

  dispose(): void {
    this._isClosed = true;
    this._unwatch();
    this._selectionListeners.clear();
    this.editorRef.current = null;
    if (this._saveTimer !== null) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // Last-chance write. Nobody awaits it, but the RPC completes regardless.
    if (this.saveState === 'unsaved') void this._write();
  }

  // ── editor callbacks ───────────────────────────────────────────────────────

  handleEditorChange(content: string, origin: 'local' | 'external'): void {
    this.content = content;
    if (origin === 'external') return;
    this.saveState = 'unsaved';
    this._handle?.pin();
    this._scheduleSave();
  }

  handleSelectionChange = (selection: DocSelection): void => {
    for (const listener of this._selectionListeners) listener(selection);
  };

  /**
   * Extension point for the comments layer: observe caret/selection movement
   * (offsets, selected text, and a viewport rect for anchoring UI).
   */
  subscribeSelection(listener: (selection: DocSelection) => void): () => void {
    this._selectionListeners.add(listener);
    return () => {
      this._selectionListeners.delete(listener);
    };
  }

  // ── commands ───────────────────────────────────────────────────────────────

  setViewMode(mode: DocViewMode): void {
    this.viewMode = mode;
  }

  dismissDiskUpdate(): void {
    this.hasDiskUpdate = false;
  }

  /** Writes pending edits immediately. Called on Cmd+S, deactivate and close. */
  async flush(): Promise<void> {
    if (this._saveTimer !== null) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this.saveState !== 'unsaved') return;
    await this._write();
  }

  /** Drops local changes and takes whatever is on disk. Backs the reload pill. */
  async reloadFromDisk(): Promise<void> {
    const read = await this._readDisk();
    if ('error' in read || this._isClosed) return;
    if (this._saveTimer !== null) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._absorb(read.content);
  }

  // ── disk ───────────────────────────────────────────────────────────────────

  private async _readDisk(): Promise<DiskRead> {
    try {
      const result = await rpc.workspace.files.readFile(
        this.projectId,
        this.workspaceId,
        this.path,
        MAX_DOC_BYTES
      );
      if (!result.success) return { error: describeError(result.error) };
      if (result.data.truncated) return { error: 'File is too large to open as a document.' };
      return { content: result.data.content };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'The file could not be read.' };
    }
  }

  private async _loadInitial(): Promise<void> {
    const read = await this._readDisk();
    if (this._isClosed) return;
    if ('error' in read) {
      runInAction(() => {
        this.isLoading = false;
        this.loadError = read.error;
      });
      return;
    }
    this._diskSignature = contentSignature(read.content);
    runInAction(() => {
      this.content = read.content;
      this.isLoading = false;
      this.loadError = null;
      this.saveState = 'saved';
    });
  }

  private async _syncFromDisk(): Promise<void> {
    if (this._isClosed || this.isLoading || this.loadError) return;
    // Mid-write the disk is in flux and our own completion path will record the
    // resulting signature; genuine external edits re-fire once it settles.
    if (this.saveState === 'saving') return;

    const read = await this._readDisk();
    if ('error' in read || this._isClosed) return;

    const signature = contentSignature(read.content);
    // Our own write, or a duplicate event for content we already absorbed.
    if (signature === this._diskSignature) return;
    if (read.content === this.content) {
      this._diskSignature = signature;
      return;
    }

    if (this.saveState === 'unsaved') {
      // Never clobber unsaved input — offer a reload instead.
      runInAction(() => {
        this.hasDiskUpdate = true;
      });
      return;
    }

    this._absorb(read.content);
  }

  /** Splices the new content into the live buffer, preserving cursor and scroll. */
  private _absorb(content: string): void {
    this.editorRef.current?.applyExternal(content);
    this._diskSignature = contentSignature(content);
    runInAction(() => {
      this.content = content;
      this.saveState = 'saved';
      this.hasDiskUpdate = false;
    });
  }

  private _scheduleSave(): void {
    if (this._isClosed) return;
    if (this._saveTimer !== null) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      void this._write();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Writes the buffer, looping until it stops moving so keystrokes landing
   * during a write are never dropped. Concurrent callers are collapsed: a
   * second call while a write is in flight is a no-op because the running loop
   * will pick up the newer content on its next pass.
   */
  private async _write(): Promise<void> {
    if (this._writeInFlight || this.isLoading || this.loadError) return;
    this._writeInFlight = true;
    try {
      for (;;) {
        const pending = this.content;
        runInAction(() => {
          this.saveState = 'saving';
        });

        const result = await rpc.workspace.files.writeFile(
          this.projectId,
          this.workspaceId,
          this.path,
          pending
        );

        if (!result.success) {
          runInAction(() => {
            this.saveState = 'unsaved';
          });
          toast({
            title: 'Save failed',
            description: describeError(result.error),
            variant: 'destructive',
          });
          return;
        }

        this._diskSignature = contentSignature(pending);
        if (this.content === pending) {
          runInAction(() => {
            this.saveState = 'saved';
          });
          return;
        }
      }
    } finally {
      this._writeInFlight = false;
    }
  }
}
