import { EditorView } from '@codemirror/view';
import { action, makeObservable, observable, reaction, runInAction } from 'mobx';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { RigCommentMessage, RigCommentTarget, RigCommentsError } from '@shared/rig/comments';
import type { DocTabResource } from '../doc-file-sync';
import { buildAnchor, groupThreads, reanchor } from './anchors';
import { setCommentMarkers, type CommentMarker } from './comment-decorations';

/**
 * Relay-backed comment threads for one doc tab.
 *
 * Ownership split: this store owns the data and the anchor positions; the CM6
 * extension in `comment-decorations.ts` only paints what it is handed. Positions
 * are pushed into the view with a StateEffect on every recompute — the extension
 * never fetches.
 *
 * Anchors are recomputed from scratch whenever the buffer changes (plain string
 * search, so cheap) rather than mapped through changesets: that keeps markers
 * correct across the external-edit splices an agent produces, and keeps this
 * store the single source of truth for "where does this thread point".
 */

const POLL_INTERVAL_MS = 8_000; // matches the web hub's cadence

export type CommentsState = 'loading' | 'ready' | 'unauthenticated' | 'notBound' | 'error';

export type CommentThread = {
  root: RigCommentMessage;
  replies: RigCommentMessage[];
  /** Document offset of the anchor, or null when it can't be positioned. */
  index: number | null;
  /** The quoted passage no longer exists in the document. */
  orphan: boolean;
  resolved: boolean;
};

export class DocCommentsStore {
  threads: CommentThread[] = [];
  state: CommentsState = 'loading';
  /** One-line explanation for `state === 'error'`. */
  errorMessage: string | null = null;
  target: RigCommentTarget | null = null;

  /** Quote captured from the selection while a new-thread composer is open. */
  composerQuote: string | null = null;
  /** Thread card the UI should scroll to / highlight. */
  focusedThreadId: string | null = null;
  /** Ids with an in-flight mutation, so cards can disable their controls. */
  pending = new Set<string>();

  private readonly _resource: DocTabResource;
  private _messages: RigCommentMessage[] = [];
  private _pollTimer: number | null = null;
  private _visible = false;
  private _disposed = false;
  private readonly _stopContentReaction: () => void;

  constructor(resource: DocTabResource) {
    this._resource = resource;

    makeObservable<this, '_reanchor' | '_applyMessages' | '_fail'>(this, {
      threads: observable,
      state: observable,
      errorMessage: observable,
      target: observable.ref,
      composerQuote: observable,
      focusedThreadId: observable,
      pending: observable.shallow,
      openComposer: action.bound,
      closeComposer: action.bound,
      focusThread: action.bound,
      _reanchor: action,
      _applyMessages: action,
      _fail: action,
    });

    // Every buffer change re-runs the anchor search: keystrokes, an absorbed
    // agent edit, and the initial disk read all land here.
    this._stopContentReaction = reaction(
      () => this._resource.content,
      () => this._reanchor()
    );

    void this._resolveTarget();
  }

  get path(): string {
    return this._resource.path;
  }

  /** Threads worth showing a margin for. */
  get unresolvedThreads(): CommentThread[] {
    return this.threads.filter((thread) => !thread.resolved);
  }

  get resolvedThreads(): CommentThread[] {
    return this.threads.filter((thread) => thread.resolved);
  }

  get hasContent(): boolean {
    return this.threads.length > 0 || this.composerQuote !== null;
  }

  dispose(): void {
    this._disposed = true;
    this._stopContentReaction();
    this._stopPolling();
  }

  /** Polling follows tab visibility — a hidden doc tab costs nothing. */
  setVisible(visible: boolean): void {
    if (this._visible === visible) return;
    this._visible = visible;
    if (visible) {
      void this.refresh();
      this._startPolling();
    } else {
      this._stopPolling();
    }
  }

  openComposer(quote: string): void {
    this.composerQuote = quote;
    this.focusedThreadId = null;
    // The reader is about to act on a state we previously gave up on — a
    // `rig login` or a relay hiccup may well have been fixed since.
    if (this.state === 'unauthenticated' || this.state === 'error') void this.refresh();
  }

  closeComposer(): void {
    this.composerQuote = null;
  }

  /** Focus a thread's card, and bring its anchored passage into view. */
  focusThread(id: string | null): void {
    this.focusedThreadId = id;
    const thread = id === null ? null : this.threads.find((t) => t.root.id === id);
    if (!thread || thread.index === null) return;
    const view = this._resource.editorRef.current?.getView();
    if (!view || thread.index > view.state.doc.length) return;
    view.dispatch({ effects: EditorView.scrollIntoView(thread.index, { y: 'nearest' }) });
  }

  /** Repaint the in-editor markers. Called once the CM6 view is mounted. */
  syncMarkers(): void {
    this._paintMarkers(this.threads, this._resource.content.length);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (this._disposed || this.state === 'notBound') return;
    const result = await rpc.rig.comments.list({ absPath: this.path });
    if (this._disposed) return;
    if (!result.success) {
      this._fail(result.error);
      return;
    }
    this._applyMessages(result.data.messages);
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * Post a new thread anchored to `quote`. Refuses a quote that isn't verbatim
   * text of the current buffer — the guardrail the CLI and hub also enforce.
   */
  async create(quote: string, body: string): Promise<boolean> {
    const built = buildAnchor(this._resource.content, quote);
    if (!built.ok) {
      toast({
        title: "Couldn't anchor that comment",
        description: built.whitespaceOnly
          ? 'The quoted passage only matches with different spacing. Re-select it and try again.'
          : 'The quoted passage is no longer in the document. Re-select it and try again.',
        variant: 'destructive',
      });
      return false;
    }
    return this._mutate('new', async () => {
      const result = await rpc.rig.comments.create({
        absPath: this.path,
        body,
        anchor: built.anchor,
      });
      if (result.success) {
        runInAction(() => {
          this.composerQuote = null;
          this.focusedThreadId = result.data.id;
        });
      }
      return result;
    });
  }

  async reply(rootId: string, body: string): Promise<boolean> {
    return this._mutate(rootId, () =>
      rpc.rig.comments.reply({ absPath: this.path, parentId: rootId, body })
    );
  }

  async setResolved(rootId: string, resolved: boolean): Promise<boolean> {
    return this._mutate(rootId, () =>
      rpc.rig.comments.setResolved({ absPath: this.path, messageId: rootId, resolved })
    );
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async _resolveTarget(): Promise<void> {
    const result = await rpc.rig.comments.resolveTarget({ absPath: this.path });
    if (this._disposed) return;
    if (!result.success) {
      this._fail(result.error);
      return;
    }
    runInAction(() => {
      this.target = result.data;
    });
    // No fetch here — `setVisible` owns the first read and the poll timer.
  }

  /**
   * Runs one mutation, then re-reads: the relay is the authority on ordering,
   * resolution state and author identity, so we never patch locally.
   */
  private async _mutate(
    key: string,
    run: () => Promise<{ success: true } | { success: false; error: RigCommentsError }>
  ): Promise<boolean> {
    runInAction(() => {
      this.pending.add(key);
    });
    try {
      const result = await run();
      if (this._disposed) return false;
      if (!result.success) {
        toast({
          title: 'Comment not saved',
          description: result.error.message,
          variant: 'destructive',
        });
        return false;
      }
      await this.refresh();
      return true;
    } finally {
      runInAction(() => {
        this.pending.delete(key);
      });
    }
  }

  private _applyMessages(messages: RigCommentMessage[]): void {
    this._messages = messages;
    this.state = 'ready';
    this.errorMessage = null;
    this._reanchor();
    // A read succeeding after an error/sign-out resumes the poll `_fail` stopped.
    if (this._visible) this._startPolling();
  }

  private _fail(error: RigCommentsError): void {
    if (error.kind === 'notBound' || error.kind === 'unauthenticated') {
      this.state = error.kind;
      this.errorMessage = null;
      this._stopPolling();
      return;
    }
    // A failed read never discards threads we already have: the margin keeps
    // rendering them and shows this message as a retryable banner above.
    this.state = 'error';
    this.errorMessage = error.message;
  }

  /** Recompute anchor positions against the live buffer and repaint the markers. */
  private _reanchor(): void {
    const text = this._resource.content;
    const threads: CommentThread[] = [];

    for (const { root, replies } of groupThreads(this._messages)) {
      const located = reanchor(text, root.anchor);
      threads.push({
        root,
        replies: [...replies].sort((a, b) => a.seq.localeCompare(b.seq)),
        index: located.status === 'anchored' && located.index !== undefined ? located.index : null,
        orphan: located.status === 'orphan',
        resolved: root.resolvedAt !== null,
      });
    }

    // Reading order: positioned threads by offset, then unpositioned, orphans last.
    threads.sort((a, b) => {
      const rank = (t: CommentThread) => (t.orphan ? 2 : t.index === null ? 1 : 0);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (a.index !== null && b.index !== null && a.index !== b.index) return a.index - b.index;
      return a.root.createdAt.localeCompare(b.root.createdAt);
    });

    this.threads = threads;
    this._paintMarkers(threads, text.length);
  }

  private _paintMarkers(threads: CommentThread[], docLength: number): void {
    const view = this._resource.editorRef.current?.getView();
    if (!view) return;
    const markers: CommentMarker[] = [];
    for (const thread of threads) {
      if (thread.index === null || !thread.root.anchor) continue;
      const from = thread.index;
      const to = Math.min(from + thread.root.anchor.exact.length, docLength);
      if (to <= from) continue;
      markers.push({ id: thread.root.id, from, to, resolved: thread.resolved });
    }
    view.dispatch({ effects: setCommentMarkers.of(markers) });
  }

  private _startPolling(): void {
    if (this._pollTimer !== null || this._disposed) return;
    if (this.state === 'notBound' || this.state === 'unauthenticated') return;
    this._pollTimer = window.setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  private _stopPolling(): void {
    if (this._pollTimer === null) return;
    window.clearInterval(this._pollTimer);
    this._pollTimer = null;
  }
}

/**
 * Per-doc-tab stores, keyed on the resource so `doc-file-sync.ts` stays free of
 * any comments import (and the dependency runs one way only).
 */
const stores = new WeakMap<DocTabResource, DocCommentsStore>();

/** Creates the store and registers the CM6 extension. Call before the tab mounts. */
export function attachDocComments(resource: DocTabResource): DocCommentsStore {
  const existing = stores.get(resource);
  if (existing) return existing;
  const store = new DocCommentsStore(resource);
  stores.set(resource, store);
  return store;
}

export function docCommentsFor(resource: DocTabResource): DocCommentsStore | null {
  return stores.get(resource) ?? null;
}

export function disposeDocComments(resource: DocTabResource): void {
  stores.get(resource)?.dispose();
  stores.delete(resource);
}
