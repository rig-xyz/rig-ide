import { EditorView } from '@codemirror/view';
import { action, makeObservable, observable, reaction, runInAction } from 'mobx';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import {
  rigCommentPermissionsChannel,
  type RigCommentMessage,
  type RigCommentPermissionRequest,
  type RigCommentTarget,
  type RigCommentThreadEntry,
  type RigCommentsError,
} from '@shared/rig/comments';
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
/** While an @mention is out, a reply can land at any moment — watch more closely. */
const MENTION_POLL_INTERVAL_MS = 3_000;

/**
 * Reader-local view state, per document, beside `docs:comments-margin-width`.
 *
 * Both are opinions about *this* reader's reading — which threads they have
 * folded away and how far through each one they have got — so they live in
 * localStorage rather than on the relay, and are keyed by the document they
 * belong to. Reads are parse-tolerant (a corrupt or hand-edited blob degrades
 * to "nothing collapsed, nothing seen") and writes are pruned to the threads
 * that still exist, so a long-lived document can't grow an unbounded blob.
 */
const COLLAPSED_STORAGE_PREFIX = 'docs:comments-collapsed';
const SEEN_STORAGE_PREFIX = 'docs:comments-seen';
const FILTER_STORAGE_PREFIX = 'docs:comments-filter';
const MAX_PERSISTED_THREADS = 200;

function readStored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable; the state simply won't survive the session.
  }
}

/**
 * The most recent thing said in a thread.
 *
 * ISO-8601 timestamps from the relay, compared as strings — the same assumption
 * `_reanchor` already makes when it orders threads by `createdAt`.
 */
export function threadLatestAt(thread: CommentThread): string {
  let latest = thread.root.createdAt;
  for (const reply of thread.replies) {
    if (reply.createdAt > latest) latest = reply.createdAt;
  }
  return latest;
}

export type CommentsState = 'loading' | 'ready' | 'unauthenticated' | 'notBound' | 'error';

/**
 * Which half of the pane the reader clicked to select a thread.
 *
 * It decides which half moves: click a card and the document scrolls its passage
 * into view; click the passage and the document stays exactly where it is while
 * the margin scrolls the card in instead. Scrolling both would fight the reader.
 */
export type ActiveThreadSource = 'document' | 'margin';

/** An agent the reader mentioned: the provider to run, and what to call it. */
export type AgentMention = { providerId: string; name: string };

/**
 * An agent turn running for one thread.
 *
 * Deliberately not persisted: the relay has no draft state, so this exists only
 * to keep the margin honest between "the mention was sent" and "the answer
 * arrived". It is cleared when the real reply is fetched, and replaced by a
 * retryable error when the turn fails.
 */
export type PendingAgentReply = {
  agentName: string;
  /** Null while the turn is running; a one-line explanation once it has failed. */
  error: string | null;
  /** Kept so the card's Retry can re-run the exact same request. */
  request: AgentReplyRequest;
};

type AgentReplyRequest = {
  parentId: string;
  providerId: string;
  quote: string | null;
  thread: RigCommentThreadEntry[];
};

/** How the agent should see one earlier message of the thread. */
function toThreadEntry(message: RigCommentMessage): RigCommentThreadEntry {
  const agent = message.meta?.agent;
  const author =
    message.author.kind === 'agent'
      ? typeof agent === 'string' && agent.trim()
        ? agent.trim()
        : 'an agent'
      : (message.author.name ?? 'someone');
  return { author, body: message.body };
}

/**
 * The provider behind a `meta.agent` label, or null when there isn't one.
 *
 * The label is the rig ecosystem's name for the agent, not a provider id: the
 * CLI and this app both stamp `claude-code` for Claude and the provider's own
 * id for everything else, so `claude-code` is the one case that has to be
 * mapped back by hand.
 */
export function providerIdForAgentLabel(meta: Record<string, unknown> | null): string | null {
  const label = meta?.agent;
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  return trimmed === 'claude-code' ? 'claude' : trimmed;
}

/**
 * The agent already taking part in a thread — the one a plain reply continues
 * talking to, with no `@mention` needed.
 *
 * Read from the *most recent* agent-authored message, so bringing a second
 * agent in by name hands the thread over to it from that point on. A thread
 * answered by a provider this machine cannot run falls back to the app's
 * default agent rather than going silent; when even that is unavailable there
 * is nobody to dispatch to, and a plain reply stays a plain reply.
 */
export function threadAgent(
  thread: CommentThread,
  agents: readonly AgentMention[],
  fallback: AgentMention | null
): AgentMention | null {
  const messages = [thread.root, ...thread.replies];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.author.kind !== 'agent') continue;
    const providerId = providerIdForAgentLabel(message.meta);
    return agents.find((agent) => agent.providerId === providerId) ?? fallback;
  }
  return null;
}

export type CommentThread = {
  root: RigCommentMessage;
  replies: RigCommentMessage[];
  /** Document offset of the anchor, or null when it can't be positioned. */
  index: number | null;
  /** The quoted passage no longer exists in the document. */
  orphan: boolean;
  resolved: boolean;
};

/**
 * The lenses the margin can read a document's threads through.
 *
 * Every one of them is answerable from what the store already holds — the
 * resolved flag, the unread marker, and the author kind of each message — so
 * choosing one costs no read and asks the relay nothing.
 */
export const COMMENT_FILTERS = ['all', 'unresolved', 'new', 'resolved', 'agent'] as const;
export type CommentFilter = (typeof COMMENT_FILTERS)[number];

function isCommentFilter(value: unknown): value is CommentFilter {
  return typeof value === 'string' && (COMMENT_FILTERS as readonly string[]).includes(value);
}

/** True when an agent has spoken in a thread — its opening comment or any reply. */
export function threadHasAgent(thread: CommentThread): boolean {
  if (thread.root.author.kind === 'agent') return true;
  return thread.replies.some((reply) => reply.author.kind === 'agent');
}

export class DocCommentsStore {
  threads: CommentThread[] = [];
  state: CommentsState = 'loading';
  /** One-line explanation for `state === 'error'`. */
  errorMessage: string | null = null;
  target: RigCommentTarget | null = null;

  /** Quote captured from the selection while a new-thread composer is open. */
  composerQuote: string | null = null;
  /**
   * The thread the reader is currently reading, shared by the document and the
   * margin so both can point at the same conversation: the anchored passage and
   * its card take the same accent, and each side scrolls the other into view.
   *
   * View state, deliberately not persisted — it says where attention is right
   * now, which is nobody's business between sessions.
   */
  activeThreadId: string | null = null;
  /** Ids with an in-flight mutation, so cards can disable their controls. */
  pending = new Set<string>();
  /** Thread root id → the agent turn running (or failed) for it. */
  agentReplies = new Map<string, PendingAgentReply>();
  /**
   * Thread root id → what that thread's agent is waiting for permission to do.
   *
   * Pushed by main, which follows the headless session directly; this store only
   * mirrors it. Absent means nothing is blocked — including once the turn ends,
   * which main announces with an empty set.
   */
  agentPermissions = new Map<string, RigCommentPermissionRequest[]>();

  /**
   * Threads the reader has folded down to their summary line. Persisted: a
   * thread you have finished with should still be out of the way tomorrow.
   */
  collapsedThreads = new Set<string>();
  /**
   * Threads whose folded middle the reader has opened. Deliberately *not*
   * persisted — "show me the whole of this conversation" is a thing you want
   * now, not a preference, and it expires with the pane.
   */
  expandedThreads = new Set<string>();
  /**
   * Thread root id → the latest message timestamp the reader has actually
   * looked at. Anything newer than the marker is unread; a thread with no
   * marker at all has never been read.
   */
  seenAt = new Map<string, string>();
  /**
   * Which threads the margin lists. Persisted beside the collapse and unread
   * state: it is the same kind of thing — an opinion about *this* reader's
   * reading of *this* document, and no business of the relay's.
   */
  filter: CommentFilter = 'all';

  private readonly _resource: DocTabResource;
  private _messages: RigCommentMessage[] = [];
  /**
   * Message ids from the previous read, so a poll can tell an arrival from a
   * message that was simply already there. Null until the first read lands —
   * restoring a document must not be mistaken for everything arriving at once.
   */
  private _knownMessageIds: Set<string> | null = null;
  private _pollTimer: number | null = null;
  private _pollIntervalMs = POLL_INTERVAL_MS;
  private _visible = false;
  private _disposed = false;
  private readonly _stopContentReaction: () => void;
  private readonly _stopPermissionEvents: () => void;

  constructor(resource: DocTabResource) {
    this._resource = resource;

    makeObservable<this, '_reanchor' | '_applyMessages' | '_fail' | '_loadViewState'>(this, {
      threads: observable,
      state: observable,
      errorMessage: observable,
      target: observable.ref,
      composerQuote: observable,
      activeThreadId: observable,
      pending: observable.shallow,
      agentReplies: observable.shallow,
      agentPermissions: observable.shallow,
      collapsedThreads: observable.shallow,
      expandedThreads: observable.shallow,
      seenAt: observable.shallow,
      filter: observable,
      setFilter: action.bound,
      openComposer: action.bound,
      closeComposer: action.bound,
      setActiveThread: action.bound,
      dismissAgentReply: action.bound,
      toggleThreadCollapsed: action.bound,
      setThreadsCollapsed: action.bound,
      expandThreadReplies: action.bound,
      markThreadSeen: action.bound,
      jumpToFirstUnread: action.bound,
      _reanchor: action,
      _applyMessages: action,
      _fail: action,
      _loadViewState: action,
    });

    this._loadViewState();

    // Every buffer change re-runs the anchor search: keystrokes, an absorbed
    // agent edit, and the initial disk read all land here.
    this._stopContentReaction = reaction(
      () => this._resource.content,
      () => this._reanchor()
    );

    // One channel for every doc tab: main names the file each update is about.
    this._stopPermissionEvents = events.on(rigCommentPermissionsChannel, (update) => {
      if (this._disposed || update.absPath !== this.path) return;
      runInAction(() => {
        if (update.requests.length === 0) this.agentPermissions.delete(update.rootId);
        else this.agentPermissions.set(update.rootId, update.requests);
      });
    });

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
    return this.threads.length > 0 || this.composerQuote !== null || this.agentReplies.size > 0;
  }

  /**
   * Threads that have said something since the reader last looked.
   *
   * Resolved threads are counted with the rest: resolving a thread ends the
   * question, it does not mute the people still answering it.
   */
  get unreadThreads(): CommentThread[] {
    return this.threads.filter((thread) => this.isThreadUnread(thread));
  }

  get unreadCount(): number {
    return this.unreadThreads.length;
  }

  isThreadUnread(thread: CommentThread): boolean {
    const seen = this.seenAt.get(thread.root.id);
    return seen === undefined || threadLatestAt(thread) > seen;
  }

  /** Choose the lens the margin lists threads through. */
  setFilter(filter: CommentFilter): void {
    if (this.filter === filter) return;
    this.filter = filter;
    writeStored(`${FILTER_STORAGE_PREFIX}:${this.path}`, filter);
  }

  /**
   * The margin's main column, under the current filter.
   *
   * `all` is the layout the margin has always had — open threads here, resolved
   * ones behind their own disclosure. Every other lens is one flat list instead:
   * a filter that has already decided what the reader wants to see has no
   * business hiding half of it behind a second control.
   */
  get visibleThreads(): CommentThread[] {
    if (this.filter === 'all') return this.unresolvedThreads;
    return this.threads.filter((thread) => this._passesFilter(thread));
  }

  /** What sits behind the `N resolved` disclosure. Only the unfiltered view has one. */
  get visibleResolvedThreads(): CommentThread[] {
    return this.filter === 'all' ? this.resolvedThreads : [];
  }

  /**
   * The selected thread is listed whatever the filter says.
   *
   * A passage clicked in the document must have a card to scroll to, and reading
   * a thread marks it read — which under `new` would otherwise pull it out from
   * under the reader mid-sentence.
   */
  private _passesFilter(thread: CommentThread): boolean {
    if (thread.root.id === this.activeThreadId) return true;
    switch (this.filter) {
      case 'unresolved':
        return !thread.resolved;
      case 'new':
        return this.isThreadUnread(thread);
      case 'resolved':
        return thread.resolved;
      case 'agent':
        return threadHasAgent(thread);
      default:
        return true;
    }
  }

  isThreadCollapsed(rootId: string): boolean {
    return this.collapsedThreads.has(rootId);
  }

  /** True once the reader has opened this thread's folded middle. */
  areThreadRepliesExpanded(rootId: string): boolean {
    return this.expandedThreads.has(rootId);
  }

  /** Fold a thread down to its summary line, or open it back up. */
  toggleThreadCollapsed(rootId: string): void {
    if (this.collapsedThreads.has(rootId)) this.collapsedThreads.delete(rootId);
    else this.collapsedThreads.add(rootId);
    this._persistCollapsed();
  }

  /**
   * Fold a set of threads down, or open them all back up, in one go.
   *
   * The same per-thread state the chevrons write, so there is no separate "all
   * collapsed" flag that could drift out of step with it: this is a moment in
   * time, and a thread that is later selected or answered opens again on its
   * own terms.
   *
   * Takes ids rather than deciding for itself which threads are on screen — the
   * resolved disclosure is the margin's own state, so only the margin can say
   * what the reader can actually see.
   */
  setThreadsCollapsed(rootIds: readonly string[], collapsed: boolean): void {
    let changed = false;
    for (const id of rootIds) {
      if (collapsed) {
        if (this.collapsedThreads.has(id)) continue;
        this.collapsedThreads.add(id);
        changed = true;
      } else if (this.collapsedThreads.delete(id)) {
        changed = true;
      }
    }
    if (changed) this._persistCollapsed();
  }

  expandThreadReplies(rootId: string): void {
    this.expandedThreads.add(rootId);
  }

  /**
   * Record that the reader has caught up with a thread.
   *
   * Called when a thread becomes the active one — deliberate attention, not the
   * accident of scrolling past it — so the dot survives until it is answered.
   */
  markThreadSeen(rootId: string): void {
    const thread = this.threads.find((t) => t.root.id === rootId);
    if (!thread) return;
    const latest = threadLatestAt(thread);
    if (this.seenAt.get(rootId) === latest) return;
    this.seenAt.set(rootId, latest);
    this._persistSeen();
  }

  /** Select the first thread with something new in it. Backs the "N new" chip. */
  jumpToFirstUnread(): void {
    const next = this.unreadThreads[0];
    if (next) this.setActiveThread(next.root.id, 'margin');
  }

  dispose(): void {
    this._disposed = true;
    this._stopContentReaction();
    this._stopPermissionEvents();
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
    this.setActiveThread(null);
    // The reader is about to act on a state we previously gave up on — a
    // `rig login` or a relay hiccup may well have been fixed since.
    if (this.state === 'unauthenticated' || this.state === 'error') void this.refresh();
  }

  closeComposer(): void {
    this.composerQuote = null;
  }

  /**
   * Select a thread, or clear the selection with `null`.
   *
   * Sticky, the way Docs is: only another thread, Escape, or opening the
   * new-thread composer replaces it, so a stray click in the document never
   * drops the conversation the reader is halfway through.
   */
  setActiveThread(id: string | null, source: ActiveThreadSource = 'margin'): void {
    if (this.activeThreadId !== id) {
      this.activeThreadId = id;
      // The in-document accent is part of the marker set, so the selection is
      // repainted the same way every other marker change is.
      this._paintMarkers(this.threads, this._resource.content.length);
    }
    if (id !== null) {
      // The thread being read is by definition not folded away, and is by
      // definition caught up with.
      if (this.collapsedThreads.delete(id)) this._persistCollapsed();
      this.markThreadSeen(id);
    }
    // Re-clicking the card of the thread already selected still re-reveals its
    // passage — that is the gesture for "where was this again?".
    if (id === null || source === 'document') return;

    // An orphan has no passage to scroll to, and a thread whose anchor moved
    // past the end of the buffer between a poll and a keystroke has none either.
    const thread = this.threads.find((t) => t.root.id === id);
    if (!thread || thread.index === null) return;
    const view = this._resource.editorRef.current?.getView();
    if (!view || thread.index > view.state.doc.length) return;
    // Effects only, never `view.focus()`: the reader may be typing in the card.
    view.dispatch({ effects: EditorView.scrollIntoView(thread.index, { y: 'center' }) });
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
   *
   * `mention` makes the post the opening move of an agent turn: the comment is
   * still the reader's, and the answer arrives as a separate agent-authored
   * reply once the turn finishes.
   */
  async create(quote: string, body: string, mention?: AgentMention): Promise<boolean> {
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
          this.activeThreadId = result.data.id;
        });
        // A brand-new thread has no history: the posted comment is the thread.
        if (mention) {
          this._runAgent(mention.name, {
            parentId: result.data.id,
            providerId: mention.providerId,
            quote,
            thread: [toThreadEntry(result.data)],
          });
        }
      }
      return result;
    });
  }

  /**
   * Reply to a thread, optionally handing it to an agent.
   *
   * `mention` is whoever should answer: the agent named explicitly in the body,
   * or — for a thread an agent is already taking part in — that agent, so a
   * follow-up continues the conversation without re-`@`-ing it. Either way the
   * dispatch decision is the caller's; this only refuses the one case that
   * would loop, an agent-authored post answering itself.
   */
  async reply(rootId: string, body: string, mention?: AgentMention): Promise<boolean> {
    return this._mutate(rootId, async () => {
      const result = await rpc.rig.comments.reply({
        absPath: this.path,
        parentId: rootId,
        body,
      });
      if (result.success && mention && result.data.author.kind !== 'agent') {
        // Built from the POST response rather than the next poll, so the agent
        // sees the message it is answering without waiting for a refresh.
        const thread = this.threads.find((t) => t.root.id === rootId);
        const prior = thread ? [thread.root, ...thread.replies] : [];
        this._runAgent(mention.name, {
          parentId: rootId,
          providerId: mention.providerId,
          quote: thread?.root.anchor?.exact ?? null,
          thread: [...prior, result.data].map(toThreadEntry),
        });
      }
      return result;
    });
  }

  /** Re-run a mention whose turn failed, from the same thread context. */
  retryAgentReply(rootId: string): void {
    const entry = this.agentReplies.get(rootId);
    if (!entry || entry.error === null) return;
    this._runAgent(entry.agentName, entry.request);
  }

  /** Drop a failed agent turn's card. No effect while one is still running. */
  dismissAgentReply(rootId: string): void {
    if (this.agentReplies.get(rootId)?.error === null) return;
    this.agentReplies.delete(rootId);
    this._retunePolling();
  }

  agentReplyFor(rootId: string): PendingAgentReply | null {
    return this.agentReplies.get(rootId) ?? null;
  }

  /** What this thread's agent is currently blocked on, if anything. */
  agentPermissionsFor(rootId: string): RigCommentPermissionRequest[] {
    return this.agentPermissions.get(rootId) ?? [];
  }

  /**
   * Answer one permission request with the option the reader chose.
   *
   * No local patching: main republishes the session's own pending set the moment
   * the broker settles, so the card empties because the agent moved on, not
   * because we guessed it would. Until then the buttons are marked pending.
   */
  resolveAgentPermission(rootId: string, requestId: string, optionId: string): void {
    if (this.pending.has(requestId)) return;
    runInAction(() => {
      this.pending.add(requestId);
    });
    void (async () => {
      const result = await rpc.rig.comments.resolveCommentPermission({
        rootId,
        requestId,
        optionId,
      });
      if (this._disposed) return;
      runInAction(() => {
        this.pending.delete(requestId);
      });
      if (!result.success) {
        toast({
          title: 'Could not answer the agent',
          description: result.error.message,
          variant: 'destructive',
        });
      }
    })();
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

  /**
   * One agent turn, start to finish.
   *
   * The placeholder goes up before the request leaves, so the card appears in
   * the same frame as the reader's own comment; the answer itself is a single
   * long round-trip in the main process. Nothing here patches the thread — the
   * relay stays the authority, so the turn ends with a refresh and the reply
   * arrives through the same read path as everybody else's.
   */
  private _runAgent(agentName: string, request: AgentReplyRequest): void {
    const rootId = request.parentId;
    runInAction(() => {
      this.agentReplies.set(rootId, { agentName, error: null, request });
    });
    this._retunePolling();

    void (async () => {
      const result = await rpc.rig.comments.askAgent({
        absPath: this.path,
        projectId: this._resource.projectId,
        taskId: this._resource.taskId,
        parentId: request.parentId,
        providerId: request.providerId,
        quote: request.quote,
        thread: request.thread,
      });
      if (this._disposed) return;

      runInAction(() => {
        if (result.success) {
          this.agentReplies.delete(rootId);
        } else {
          this.agentReplies.set(rootId, { agentName, error: result.error.message, request });
        }
      });
      this._retunePolling();
      // Don't wait for the next tick: the reply exists on the relay right now.
      if (result.success) await this.refresh();
    })();
  }

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
    const arrivals = this._takeArrivals(messages);
    this._messages = messages;
    this.state = 'ready';
    this.errorMessage = null;
    this._reanchor();

    // Nothing that just arrived may be hidden by either fold: a reply the
    // reader has not seen is the whole reason to look at the margin.
    if (arrivals.size > 0) {
      let uncollapsed = false;
      for (const rootId of arrivals) {
        if (this.collapsedThreads.delete(rootId)) uncollapsed = true;
        this.expandedThreads.add(rootId);
      }
      if (uncollapsed) this._persistCollapsed();
    }
    // A reply landing in the thread the reader is already reading is not news.
    if (this.activeThreadId !== null) this.markThreadSeen(this.activeThreadId);

    // A read succeeding after an error/sign-out resumes the poll `_fail` stopped.
    if (this._visible) this._startPolling();
  }

  /**
   * The threads a read has brought genuinely new messages to, and the point at
   * which "new" starts being meaningful.
   */
  private _takeArrivals(messages: RigCommentMessage[]): Set<string> {
    const known = this._knownMessageIds;
    this._knownMessageIds = new Set(messages.map((message) => message.id));
    if (known === null) return new Set();
    const roots = new Set<string>();
    for (const message of messages) {
      if (!known.has(message.id)) roots.add(message.parentId ?? message.id);
    }
    return roots;
  }

  private _loadViewState(): void {
    const collapsed = readStored(`${COLLAPSED_STORAGE_PREFIX}:${this.path}`);
    if (Array.isArray(collapsed)) {
      for (const id of collapsed.slice(0, MAX_PERSISTED_THREADS)) {
        if (typeof id === 'string' && id.length > 0) this.collapsedThreads.add(id);
      }
    }
    const seen = readStored(`${SEEN_STORAGE_PREFIX}:${this.path}`);
    if (seen !== null && typeof seen === 'object' && !Array.isArray(seen)) {
      for (const [id, at] of Object.entries(seen).slice(0, MAX_PERSISTED_THREADS)) {
        if (typeof at === 'string' && at.length > 0) this.seenAt.set(id, at);
      }
    }
    const filter = readStored(`${FILTER_STORAGE_PREFIX}:${this.path}`);
    if (isCommentFilter(filter)) this.filter = filter;
  }

  /**
   * Writes back only the threads that still exist: a document whose comments
   * come and go over months must not accumulate a blob of dead ids.
   */
  private _persistCollapsed(): void {
    const live = new Set(this.threads.map((thread) => thread.root.id));
    const ids = [...this.collapsedThreads]
      .filter((id) => live.has(id))
      .slice(0, MAX_PERSISTED_THREADS);
    writeStored(`${COLLAPSED_STORAGE_PREFIX}:${this.path}`, ids);
  }

  private _persistSeen(): void {
    const live = new Set(this.threads.map((thread) => thread.root.id));
    const entries = [...this.seenAt].filter(([id]) => live.has(id)).slice(0, MAX_PERSISTED_THREADS);
    writeStored(`${SEEN_STORAGE_PREFIX}:${this.path}`, Object.fromEntries(entries));
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
      markers.push({
        id: thread.root.id,
        from,
        to,
        resolved: thread.resolved,
        active: thread.root.id === this.activeThreadId,
      });
    }
    view.dispatch({ effects: setCommentMarkers.of(markers) });
  }

  private _startPolling(): void {
    if (this._pollTimer !== null || this._disposed) return;
    if (this.state === 'notBound' || this.state === 'unauthenticated') return;
    this._pollTimer = window.setInterval(() => void this.refresh(), this._pollIntervalMs);
  }

  /** Tightens the poll while a mention is outstanding, and relaxes it after. */
  private _retunePolling(): void {
    const outstanding = [...this.agentReplies.values()].some((entry) => entry.error === null);
    const next = outstanding ? MENTION_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    if (next === this._pollIntervalMs) return;
    this._pollIntervalMs = next;
    if (this._pollTimer === null) return;
    this._stopPolling();
    this._startPolling();
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
