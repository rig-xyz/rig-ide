/**
 * Pure state for the chat panel's tab strip — one tab per open chat, live or
 * replayed. Live tabs back a real ACP conversation (`rig-chat-store.ts`);
 * replay tabs are a read-only view of a stored `rig_sessions` row
 * (`replay-store.ts`), opened from the History list. `kind` is the only
 * thing that distinguishes them at this layer — every function below is
 * agnostic to it, since closing/reordering/labeling a tab works the same
 * way regardless of what's behind it.
 *
 * Round B (`persistence-design.md`) grounds this in real storage — `rig_sessions`
 * — where round-10-era history had none (see git blame on this file for that
 * note); the tab-strip model above stays the same either way.
 */

export type RigSessionSummary = {
  conversationId: string;
  providerId: string;
  createdAt: number;
  kind: 'live' | 'replay';
};

export function addSession(
  sessions: readonly RigSessionSummary[],
  next: RigSessionSummary
): RigSessionSummary[] {
  return [...sessions, next];
}

export function removeSession(
  sessions: readonly RigSessionSummary[],
  conversationId: string
): RigSessionSummary[] {
  return sessions.filter((s) => s.conversationId !== conversationId);
}

/** Newest first — the tab strip lists recently-started sessions on top. */
export function byRecency(sessions: readonly RigSessionSummary[]): RigSessionSummary[] {
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
}

export type CloseTabResult = {
  sessions: RigSessionSummary[];
  activeId: string | null;
};

/**
 * Closing a tab: removes it from the list, and — only when it was the
 * active one — hands the selection to the next-most-recent survivor, or to
 * the zero-state (`null`) when it was the last tab. Closing a background
 * tab never moves the active selection.
 */
export function closeTab(
  sessions: readonly RigSessionSummary[],
  activeId: string | null,
  id: string
): CloseTabResult {
  const next = removeSession(sessions, id);
  const nextActiveId = activeId === id ? (byRecency(next)[0]?.conversationId ?? null) : activeId;
  return { sessions: next, activeId: nextActiveId };
}

/** A tab's short label: the session's own title once it has one, else a plain placeholder. */
export function deriveTabTitle(title: string | null): string {
  return title ?? 'New session';
}
