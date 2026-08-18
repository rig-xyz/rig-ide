import type { RigCommentMessage } from '@shared/rig/comments';

/**
 * Offline-first comments: the last-synced thread state for one (binding,
 * file), plus the pure decision logic for telling "the relay is unreachable"
 * (a connectivity MODE) apart from a real error.
 *
 * Pure/testable by design — the actual localStorage IO lives in
 * `comments-store.ts` (reusing its existing `readStored`/`writeStored`,
 * the same parse-tolerant helpers the reader-view-state blobs already use).
 */

/** Mirrors the relay's own per-file list cap (`LIST_LIMIT` in main/rig/comments.ts). */
const MAX_CACHED_MESSAGES = 200;

export type CommentsCacheEntry = {
  bindingId: string;
  relPath: string;
  /** ISO-8601 timestamp of the read that produced this snapshot. */
  lastSyncedAt: string;
  messages: RigCommentMessage[];
};

export function toCacheEntry(
  bindingId: string,
  relPath: string,
  messages: readonly RigCommentMessage[],
  lastSyncedAt: string
): CommentsCacheEntry {
  return { bindingId, relPath, lastSyncedAt, messages: messages.slice(0, MAX_CACHED_MESSAGES) };
}

function isPlausibleMessage(value: unknown): value is RigCommentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.body === 'string' &&
    typeof m.createdAt === 'string' &&
    typeof m.author === 'object' &&
    m.author !== null
  );
}

/**
 * Parse-tolerant, like every other reader-local blob in this feature (see
 * `readStored` in comments-store.ts): a corrupt or hand-edited cache
 * degrades to "nothing cached", never a crash or a partial thread list.
 */
export function parseCommentsCache(value: unknown): CommentsCacheEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.bindingId !== 'string' || typeof raw.relPath !== 'string') return null;
  if (typeof raw.lastSyncedAt !== 'string' || raw.lastSyncedAt.length === 0) return null;
  if (!Array.isArray(raw.messages) || !raw.messages.every(isPlausibleMessage)) return null;
  return {
    bindingId: raw.bindingId,
    relPath: raw.relPath,
    lastSyncedAt: raw.lastSyncedAt,
    messages: raw.messages,
  };
}

/**
 * True when a comments-list failure means "the relay is unreachable" — a
 * connectivity MODE — rather than a real error.
 *
 * The signal already exists in `main/rig/comments.ts`: a thrown fetch/timeout
 * (`transportError`) produces `kind: 'relay'` with no `status`; every
 * relay-answered failure (4xx/5xx, via `relayError`) always carries one. Real
 * errors (a 500, a 404-not-a-member, an invalid body, a failed agent turn)
 * stay errors — only the no-`status` case is offline.
 */
export function isOfflineError(error: { kind: string; status?: number }): boolean {
  return error.kind === 'relay' && error.status === undefined;
}

/** `h:mm` + lowercase `am`/`pm`, no space — e.g. `2:04pm`. Empty on a bad timestamp. */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
    .replace(' ', '');
}

/** Label for the quiet offline chip — mono metadata, per the design system. */
export function offlineChipLabel(lastSyncedAt: string | null): string {
  if (lastSyncedAt === null) return 'offline · not yet synced';
  const clock = formatClockTime(lastSyncedAt);
  return clock.length > 0 ? `offline · last synced ${clock}` : 'offline · last synced earlier';
}
