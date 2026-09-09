/**
 * Home's "is this session working, or does it have output I haven't seen"
 * signal — tracked independently of whether the session's rig is the one
 * currently open, so `rigs-rail.tsx` can show it for a session whose rig
 * isn't on screen right now.
 *
 * `isWorking` is never written here directly — it is mirrored, lazily and
 * reactively, off whatever LIVE `RigChatStore` `rigSessionRegistry` holds
 * for the conversation (`RigChatStore.affordances.isWorking`, a MobX
 * `computed`). That registry lookup is the reason this can work for a rig
 * that isn't open at all: `chat-panel.tsx`'s own teardown effect only
 * `stop()`s a REPLAY store when its rig closes — a live one is merely
 * `detach()`ed, so it stays in the registry (and keeps running its ACP
 * session) after the user navigates back to Home. A session whose rig was
 * never opened this run has no registry entry at all and is honestly
 * `idle` here — no separate main-process source is wired for that case.
 * (Investigated: `main/core/acp/agent-status-bridge.ts` mirrors the ACP
 * runtime's session summaries into `agentHookService`, but every event it
 * emits either goes through the notification pipe or through
 * `conversationAgentStatusChangedChannel`, which is gated on a row in the
 * `conversations` table — the emdash task/workspace DB this app's rig
 * sessions were never written into; `rig-chat-store.ts`'s own `_startInput`
 * comment: `projectId`/`taskId` here are "opaque labels, never validated
 * against a real project/task row". That channel silently never fires for
 * a rig conversationId, so it isn't a usable source for this.)
 *
 * `lastOutputAt`/`lastSeenAt` ARE written here explicitly, from the two
 * call sites this feature adds: `rig-chat-store.ts`'s `_applyHistory`
 * (fresh turns just landed) and `chat-panel.tsx`'s active-tab effect (this
 * tab is the one actually visible right now).
 *
 * Module-level, not React/component state, so it survives Home ⇄ rig
 * navigation the same way `rigSessionRegistry` does — and, deliberately,
 * never persisted to disk: a relaunch starts every session `idle` again,
 * same as the registry itself starting empty.
 */
import { autorun, type IReactionDisposer } from 'mobx';
import type { RigChatStore } from './rig-chat-store';
import { rigSessionRegistry } from './session/rig-session-registry';

export type SessionAttentionFacts = {
  isWorking: boolean;
  lastOutputAt: number | null;
  lastSeenAt: number | null;
};

type RecordedFacts = { lastOutputAt: number | null; lastSeenAt: number | null };

const recordedByConversation = new Map<string, RecordedFacts>();
const isWorkingByConversation = new Map<string, boolean>();
/** Which store instance (if any) each conversation's `isWorking` mirror is currently wired to — lets `ensureWired` no-op on a repeat call and re-wire when the registry's entry actually changes. */
const wiredStoreByConversation = new Map<string, RigChatStore | null>();
const wiredDisposerByConversation = new Map<string, IReactionDisposer>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Structural check, not a type-level one: the registry doesn't enforce which concrete store lives under an id, so this reads the runtime shape rather than trusting a generic cast. */
function liveStoreFor(conversationId: string): RigChatStore | null {
  const candidate = rigSessionRegistry.get(conversationId);
  if (!candidate || (candidate as { kind?: unknown }).kind !== 'live') return null;
  return candidate as RigChatStore;
}

/**
 * Keeps `isWorkingByConversation` mirroring whatever live store the
 * registry currently holds for this id. Lazy (only starts tracking on
 * first read/write for that id) and idempotent (a repeat call while
 * already wired to the same store instance is a no-op) — cheap to call
 * from every function below rather than requiring callers to opt in.
 */
function ensureWired(conversationId: string): void {
  const live = liveStoreFor(conversationId);
  if (wiredStoreByConversation.get(conversationId) === live) return;

  wiredDisposerByConversation.get(conversationId)?.();
  wiredDisposerByConversation.delete(conversationId);
  wiredStoreByConversation.set(conversationId, live);

  if (!live) {
    if (isWorkingByConversation.get(conversationId)) notify();
    isWorkingByConversation.delete(conversationId);
    return;
  }

  wiredDisposerByConversation.set(
    conversationId,
    autorun(() => {
      const isWorking = live.affordances.isWorking;
      if (isWorkingByConversation.get(conversationId) === isWorking) return;
      isWorkingByConversation.set(conversationId, isWorking);
      notify();
    })
  );
}

/** `rig-chat-store.ts`'s one call site: new turns just landed for this conversation. */
export function noteSessionOutput(conversationId: string, at: number = Date.now()): void {
  ensureWired(conversationId);
  const prev = recordedByConversation.get(conversationId);
  recordedByConversation.set(conversationId, { lastOutputAt: at, lastSeenAt: prev?.lastSeenAt ?? null });
  notify();
}

/** `chat-panel.tsx`'s one call site: this conversation's tab is the visible, active one right now. */
export function noteSessionSeen(conversationId: string, at: number = Date.now()): void {
  ensureWired(conversationId);
  const prev = recordedByConversation.get(conversationId);
  recordedByConversation.set(conversationId, { lastOutputAt: prev?.lastOutputAt ?? null, lastSeenAt: at });
  notify();
}

/** An untracked conversation (never noted, no live store) reads as all-idle facts — see this module's own header comment. */
export function getSessionAttentionFacts(conversationId: string): SessionAttentionFacts {
  ensureWired(conversationId);
  const recorded = recordedByConversation.get(conversationId);
  return {
    isWorking: isWorkingByConversation.get(conversationId) ?? false,
    lastOutputAt: recorded?.lastOutputAt ?? null,
    lastSeenAt: recorded?.lastSeenAt ?? null,
  };
}

/** `useSyncExternalStore`'s subscribe half for one conversation — see `rigs-rail.tsx`'s `useSessionAttentionStatus`/`useRowAttentionStatus`. */
export function subscribeSessionAttention(conversationId: string, onChange: () => void): () => void {
  ensureWired(conversationId);
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Test-only: clears every module-level map/subscription between test cases. */
export function __resetSessionAttentionForTests(): void {
  for (const dispose of wiredDisposerByConversation.values()) dispose();
  recordedByConversation.clear();
  isWorkingByConversation.clear();
  wiredStoreByConversation.clear();
  wiredDisposerByConversation.clear();
  listeners.clear();
}
