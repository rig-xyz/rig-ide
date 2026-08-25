import { useSyncExternalStore } from 'react';
import type {
  CreateFileToolCall,
  DeleteFileToolCall,
  ModifyFileToolCall,
  ToolNode,
  TranscriptItem,
  TranscriptTurn,
} from '@emdash/core/acp/client';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §3, card rail
 * "In progress" cards): the only REAL live signal for "an active agent
 * session just wrote this file." Investigated first: `rig_session_events`
 * is an opaque append-only JSON blob (no path index, no live push), and
 * `rigFileChangeChannel` is `{root}`-only fs-watch churn that can't tell an
 * agent's write from a human's or the sync daemon's — see the investigation
 * notes on this round. The one genuine signal is the live `TranscriptTurn`s
 * `rig-chat-store.ts` already observes per session: `_applyHistory` calls
 * `recordFileWritesFromTurns` here with ONLY the freshly-committed delta
 * (never replayed history), once per turn commit, for whichever session is
 * live right now. This module has no ACP/reducer knowledge of its own — a
 * pure recipient, in-memory, process-lifetime only (never persisted: a
 * stale "in progress" card past its ~5 minute window is simply wrong to
 * keep, so there is nothing worth writing to disk).
 */

const WINDOW_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 1000;

export type RecentWrite = { relPath: string; at: number; sessionId: string };

const EMPTY: readonly RecentWrite[] = [];

/** root -> relPath -> most recent write. */
const writesByRoot = new Map<string, Map<string, RecentWrite>>();
/**
 * root -> every relPath EVER seen written, for the lifetime of this running
 * app process — never pruned, never persisted. File-navigator redesign
 * (§5): backs the "Changed by agents" filter, which needs a longer memory
 * than the 5-minute card window `writesByRoot` keeps. Investigated: there's
 * no durable, queryable "which session wrote which file" record in this
 * app (`rig_session_events` is an opaque per-session blob with no path
 * index — see this module's header comment) — so this can only ever
 * reflect writes THIS launch has actually observed live, never a rig's
 * full history, never anything from before the app was opened, and never
 * a specific person (every write here comes from an agent tool call, by
 * construction — no per-person provenance exists to attach).
 */
const everWrittenByRoot = new Map<string, Set<string>>();
/**
 * Referentially-stable snapshot per root, for `useSyncExternalStore`'s
 * `getSnapshot` ONLY — that contract needs the SAME reference back between
 * real changes, or React treats every render as "state changed" and can
 * loop. `getRecentWrites` (the plain, non-hook read below) never consults
 * this cache — it always recomputes live, so a call made long after the
 * last write/prune still filters correctly by the current clock.
 */
const snapshotCache = new Map<string, readonly RecentWrite[]>();
const listeners = new Set<() => void>();
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  for (const cb of listeners) cb();
}

/** Invalidated wholesale (not per-root) on every change — this store is small and write-invalidation isn't a hot path, so the simplest-correct thing wins over a finer-grained cache. */
function invalidateSnapshots(): void {
  snapshotCache.clear();
}

function pruneExpired(): void {
  const cutoff = Date.now() - WINDOW_MS;
  let changed = false;
  for (const forRoot of writesByRoot.values()) {
    for (const [relPath, entry] of forRoot) {
      if (entry.at < cutoff) {
        forRoot.delete(relPath);
        changed = true;
      }
    }
  }
  if (changed) {
    invalidateSnapshots();
    notify();
  }
}

/** Subscribe to any write recorded anywhere — components read their own root's slice via `getRecentWrites`/`useRecentWrites`. Runs a light prune sweep only while at least one subscriber is listening. */
export function subscribeWriteActivity(cb: () => void): () => void {
  listeners.add(cb);
  if (!pruneTimer) pruneTimer = setInterval(pruneExpired, PRUNE_INTERVAL_MS);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  };
}

function computeRecentWrites(root: string): RecentWrite[] {
  const forRoot = writesByRoot.get(root);
  if (!forRoot) return [];
  const cutoff = Date.now() - WINDOW_MS;
  const out: RecentWrite[] = [];
  for (const entry of forRoot.values()) {
    if (entry.at >= cutoff) out.push(entry);
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** Every file written under `root` in the last 5 minutes, newest first — always computed fresh against the current clock (safe to call any time, not just from a hook). */
export function getRecentWrites(root: string): readonly RecentWrite[] {
  return computeRecentWrites(root);
}

/** Live view of `getRecentWrites(root)` — re-renders on every write/prune under this root. */
export function useRecentWrites(root: string): readonly RecentWrite[] {
  return useSyncExternalStore(subscribeWriteActivity, () => {
    const cached = snapshotCache.get(root);
    if (cached) return cached;
    const fresh = computeRecentWrites(root);
    const stable = fresh.length > 0 ? fresh : EMPTY;
    snapshotCache.set(root, stable);
    return stable;
  });
}

function recordWrite(root: string, relPath: string, sessionId: string): void {
  let forRoot = writesByRoot.get(root);
  if (!forRoot) {
    forRoot = new Map();
    writesByRoot.set(root, forRoot);
  }
  forRoot.set(relPath, { relPath, at: Date.now(), sessionId });

  let everForRoot = everWrittenByRoot.get(root);
  if (!everForRoot) {
    everForRoot = new Set();
    everWrittenByRoot.set(root, everForRoot);
  }
  everForRoot.add(relPath);

  invalidateSnapshots();
  notify();
}

/**
 * Every relPath under `root` this app has observed an agent write to, since
 * launch — the "Changed by agents" filter's input (`shared/rig/tree-view.ts`).
 * See `everWrittenByRoot`'s own comment for exactly what this can and can't
 * attribute. Unlike `getRecentWrites`, this returns the SAME `Set` instance
 * across calls for a given root (mutated in place by `recordWrite`, always
 * paired with `notify()`) — a deliberate simplification since there's no
 * time-based filtering to redo per call.
 */
export function getEverWrittenPaths(root: string): ReadonlySet<string> {
  return everWrittenByRoot.get(root) ?? EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Live view of `getEverWrittenPaths(root)`. */
export function useEverWrittenPaths(root: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribeWriteActivity, () => getEverWrittenPaths(root));
}

function isFileWriteToolCall(
  item: TranscriptItem
): item is CreateFileToolCall | ModifyFileToolCall | DeleteFileToolCall {
  return (
    'kind' in item &&
    (item.kind === 'create-file-tool-call' ||
      item.kind === 'modify-file-tool-call' ||
      item.kind === 'delete-file-tool-call')
  );
}

function walk(items: readonly TranscriptItem[], root: string, sessionId: string): void {
  for (const item of items) {
    if (isFileWriteToolCall(item) && item.status === 'done') {
      recordWrite(root, item.path, sessionId);
    }
    const children: ToolNode[] | undefined = 'children' in item ? item.children : undefined;
    if (children && children.length > 0) walk(children, root, sessionId);
  }
}

/**
 * Called by `rig-chat-store.ts`'s `_applyHistory`, once per freshly-committed
 * turn — `turns` here is already the delta (`newTurnsSince`), never
 * previously-seen history, so a resumed session's old file edits don't
 * re-surface as "just written" on every reconnect.
 */
export function recordFileWritesFromTurns(
  turns: readonly TranscriptTurn[],
  root: string,
  sessionId: string
): void {
  for (const turn of turns) walk(turn.items, root, sessionId);
}

/** Test-only: clears every recorded write and stops the prune timer, so test files don't leak state or a live interval into each other. */
export function resetWriteActivityForTests(): void {
  writesByRoot.clear();
  everWrittenByRoot.clear();
  invalidateSnapshots();
  listeners.clear();
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
