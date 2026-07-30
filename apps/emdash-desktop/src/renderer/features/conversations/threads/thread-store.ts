/**
 * thread-store.ts — renderer-local storage for Slack-style chat threads.
 *
 * One MobX store per conversation, keyed by transcript itemId. Persisted to
 * localStorage (one key per conversation, JSON); parse failures are tolerated
 * and reset the conversation's threads. No relay calls in v0.
 *
 * `version` is a monotonic counter bumped on every mutation. AcpChatPanel
 * reads it during render (observer) and lists it as a dep of the
 * transcriptCommands useMemo, so every thread mutation produces a fresh
 * ChatCommands object → view.setCommands → the Solid thread buttons re-read
 * getThreadInfo / getReactions and refresh.
 *
 * Besides replies the store also tracks:
 * - hiddenTurns: turns whose full exchange happened in a thread and should
 *   collapse to a "discussed in thread" row in the main transcript (applied
 *   by AcpChatStore when seeding history).
 * - reactions: single-user emoji reactions per item (count is 1 when mine).
 */

import { makeAutoObservable, observable } from 'mobx';
import { log } from '@renderer/utils/logger';
import type { AcpChatStore } from '../acp/acp-chat-store';

export type ThreadAuthor = 'you' | 'agent';

export type ThreadReply = {
  author: ThreadAuthor;
  text: string;
  /** Epoch ms. */
  at: number;
};

export type ThreadState = {
  replies: ThreadReply[];
};

export type HiddenTurn = {
  /** Item id the thread is anchored to (for the collapsed row's click target). */
  anchorItemId: string;
};

const STORAGE_PREFIX = 'emdash.chat-threads.';

type PersistedShape = {
  v: 2;
  threads: Record<string, ThreadState>;
  hiddenTurns: Record<string, HiddenTurn>;
  reactions: Record<string, Record<string, { mine: boolean }>>;
};

function parseReplies(value: unknown): ThreadReply[] {
  if (!Array.isArray(value)) return [];
  const replies: ThreadReply[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as { author?: unknown; text?: unknown; at?: unknown };
    if (typeof r.text !== 'string' || typeof r.at !== 'number') continue;
    // Legacy replies (v1) have no author — they were always user-typed.
    const author: ThreadAuthor = r.author === 'agent' ? 'agent' : 'you';
    replies.push({ author, text: r.text, at: r.at });
  }
  return replies;
}

export class ConversationThreadStore {
  /** itemId → thread. */
  threads = new Map<string, ThreadState>();
  /** turnId → collapse marker for the main transcript. */
  hiddenTurns = new Map<string, HiddenTurn>();
  /** itemId → emoji → reaction state (single-user v0). */
  reactions = new Map<string, Map<string, { mine: boolean }>>();
  /** Monotonic mutation counter (see module docs). */
  version = 0;
  private loaded = false;

  constructor(readonly conversationId: string) {
    makeAutoObservable(this);
  }

  private get storageKey(): string {
    return `${STORAGE_PREFIX}${this.conversationId}`;
  }

  /** Lazy localStorage hydration; tolerates missing/corrupt/legacy payloads. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return;

      const isV2 = (parsed as { v?: unknown }).v === 2;
      const threadsRecord = isV2
        ? ((parsed as { threads?: unknown }).threads ?? {})
        : // Legacy shape: Record<itemId, { replies, sentAt? }> at the top level.
          parsed;
      if (threadsRecord !== null && typeof threadsRecord === 'object') {
        for (const [itemId, value] of Object.entries(threadsRecord as Record<string, unknown>)) {
          if (value === null || typeof value !== 'object') continue;
          const replies = parseReplies((value as { replies?: unknown }).replies);
          if (replies.length === 0) continue;
          this.threads.set(itemId, { replies });
        }
      }

      if (!isV2) return;
      const hiddenRecord = (parsed as { hiddenTurns?: unknown }).hiddenTurns;
      if (hiddenRecord !== null && typeof hiddenRecord === 'object') {
        for (const [turnId, value] of Object.entries(hiddenRecord as Record<string, unknown>)) {
          if (value === null || typeof value !== 'object') continue;
          const anchorItemId = (value as { anchorItemId?: unknown }).anchorItemId;
          if (typeof anchorItemId !== 'string') continue;
          this.hiddenTurns.set(turnId, { anchorItemId });
        }
      }
      const reactionsRecord = (parsed as { reactions?: unknown }).reactions;
      if (reactionsRecord !== null && typeof reactionsRecord === 'object') {
        for (const [itemId, value] of Object.entries(reactionsRecord as Record<string, unknown>)) {
          if (value === null || typeof value !== 'object') continue;
          const emojis = new Map<string, { mine: boolean }>();
          for (const [emoji, state] of Object.entries(value as Record<string, unknown>)) {
            if (state === null || typeof state !== 'object') continue;
            emojis.set(emoji, { mine: (state as { mine?: unknown }).mine === true });
          }
          if (emojis.size > 0) this.reactions.set(itemId, emojis);
        }
      }
    } catch (error) {
      log.warn('Failed to load chat threads from localStorage', { error });
    }
  }

  private persist(): void {
    try {
      const payload: PersistedShape = {
        v: 2,
        threads: Object.fromEntries(this.threads),
        hiddenTurns: Object.fromEntries(this.hiddenTurns),
        reactions: Object.fromEntries(
          [...this.reactions].map(([itemId, emojis]) => [itemId, Object.fromEntries(emojis)])
        ),
      };
      window.localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch (error) {
      log.warn('Failed to persist chat threads to localStorage', { error });
    }
  }

  /** All threads with at least one reply (loads from storage on first read). */
  entries(): ReadonlyMap<string, ThreadState> {
    this.ensureLoaded();
    return this.threads;
  }

  getThread(itemId: string): ThreadState | null {
    this.ensureLoaded();
    return this.threads.get(itemId) ?? null;
  }

  getThreadInfo(itemId: string): { count: number; sent: boolean } | null {
    const thread = this.getThread(itemId);
    if (!thread || thread.replies.length === 0) return null;
    // `sent` is obsolete in the pane model (every reply is sent on Enter).
    return { count: thread.replies.length, sent: false };
  }

  addReply(itemId: string, author: ThreadAuthor, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.ensureLoaded();
    const existing = this.threads.get(itemId);
    if (existing) {
      existing.replies.push({ author, text: trimmed, at: Date.now() });
    } else {
      this.threads.set(itemId, { replies: [{ author, text: trimmed, at: Date.now() }] });
    }
    this.version += 1;
    this.persist();
  }

  getHiddenTurn(turnId: string): HiddenTurn | null {
    this.ensureLoaded();
    return this.hiddenTurns.get(turnId) ?? null;
  }

  hideTurn(turnId: string, anchorItemId: string): void {
    this.ensureLoaded();
    this.hiddenTurns.set(turnId, { anchorItemId });
    this.version += 1;
    this.persist();
  }

  toggleReaction(itemId: string, emoji: string): void {
    this.ensureLoaded();
    const emojis = this.reactions.get(itemId);
    if (emojis?.get(emoji)?.mine) {
      emojis.delete(emoji);
      if (emojis.size === 0) this.reactions.delete(itemId);
    } else if (emojis) {
      emojis.set(emoji, { mine: true });
    } else {
      this.reactions.set(itemId, new Map([[emoji, { mine: true }]]));
    }
    this.version += 1;
    this.persist();
  }

  getReactions(
    itemId: string
  ): ReadonlyArray<{ emoji: string; count: number; mine: boolean }> | null {
    this.ensureLoaded();
    const emojis = this.reactions.get(itemId);
    if (!emojis || emojis.size === 0) return null;
    return [...emojis].map(([emoji, state]) => ({
      emoji,
      count: state.mine ? 1 : 0,
      mine: state.mine,
    }));
  }
}

const stores = new Map<string, ConversationThreadStore>();

export function getThreadStore(conversationId: string): ConversationThreadStore {
  let store = stores.get(conversationId);
  if (!store) {
    store = new ConversationThreadStore(conversationId);
    stores.set(conversationId, store);
  }
  return store;
}

// ── Thread pane UI state ──────────────────────────────────────────────────────

export type OpenThread = {
  taskId: string;
  conversationId: string;
  itemId: string;
  excerpt: string;
  /**
   * Direct reference to the conversation's live chat store. The tab flow
   * manages stores via AcpChatResourceManager (acpChatRegistry is never
   * populated there), so the opener passes its own store instead of the
   * pane doing a registry lookup.
   */
  store: AcpChatStore;
};

export type PendingThreadTurn = {
  conversationId: string;
  /** Anchor item id of the thread the in-flight turn belongs to. */
  itemId: string;
  turnId: string;
  /** When false the turn collapses out of the main transcript on commit. */
  alsoToChannel: boolean;
};

/**
 * Module-level UI state for the thread sidebar pane: which thread is open,
 * which sidebar tab to restore on close, and the in-flight turn being
 * captured into a thread.
 */
class ThreadUiStore {
  openThread: OpenThread | null = null;
  prevSidebarTab: string | null = null;
  pendingTurn: PendingThreadTurn | null = null;

  constructor() {
    // openThread holds a class instance (AcpChatStore) — keep it a plain
    // reference; deep-observing the store would wrap it in a proxy.
    makeAutoObservable(this, { openThread: observable.ref });
  }

  open(thread: OpenThread, prevSidebarTab: string | null): void {
    this.openThread = thread;
    this.prevSidebarTab = prevSidebarTab;
  }

  close(): void {
    this.openThread = null;
    this.prevSidebarTab = null;
  }

  setPending(pending: PendingThreadTurn): void {
    this.pendingTurn = pending;
  }

  clearPending(): void {
    this.pendingTurn = null;
  }
}

export const threadUi = new ThreadUiStore();
