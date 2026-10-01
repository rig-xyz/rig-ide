/**
 * How far you've read a space, remembered on this computer — the one source
 * of truth for both the Room's "New" line (`room-transcript.tsx`) and Home's
 * "what you missed" tiles (`features/home/space-status-state.ts`).
 *
 * Two markers per space, both in localStorage under the `rig-room-*` key
 * convention (wrapped in try/catch, since storage isn't guaranteed):
 *   - last seen: the highest message `seq` you'd scrolled to the bottom of.
 *     Written by the transcript while you're pinned to the bottom.
 *   - opened at: when you last had the space open (stamped on entering and
 *     leaving it, by `RoomView`) — what a run's end time is compared with,
 *     since a run has no message seq of its own.
 *
 * Writes notify subscribers (and other windows, via the `storage` event) so
 * Home re-reads the moment you leave a space: the Room's leave stamp lands
 * in the same commit Home first renders in, after Home has already read.
 */

import { reportSpaceRead, windowIsLooking } from '@renderer/features/notifications/space-read-sync';

const LAST_SEEN_PREFIX = 'rig-room-last-seen:';
const OPENED_AT_PREFIX = 'rig-room-opened-at:';

let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    if (localStorage.getItem(key) === String(value)) return;
    localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable: nothing is remembered next time.
    return;
  }
  notify();
}

export function readLastSeen(bindingId: string): number | null {
  return readNumber(LAST_SEEN_PREFIX + bindingId);
}

export function writeLastSeen(bindingId: string, seq: number): void {
  if (readLastSeen(bindingId) === seq) return;
  writeNumber(LAST_SEEN_PREFIX + bindingId, seq);
  // And on to the relay, so other devices and the unread counts agree.
  reportSpaceRead(bindingId, { seq, seen: windowIsLooking() });
}

/**
 * The relay's read cursor is ahead of this computer's (you read the space
 * elsewhere): catch the local marker up without sending it back. Never
 * moves the marker backwards.
 */
export function syncLastSeenFromServer(bindingId: string, seq: number): void {
  const local = readLastSeen(bindingId);
  if (local !== null && local >= seq) return;
  writeNumber(LAST_SEEN_PREFIX + bindingId, seq);
}

export function readOpenedAt(bindingId: string): number | null {
  return readNumber(OPENED_AT_PREFIX + bindingId);
}

export function writeOpenedAt(bindingId: string, at: number): void {
  writeNumber(OPENED_AT_PREFIX + bindingId, at);
}

export type SpaceReadMarker = { lastSeenSeq: number | null; openedAt: number | null };

export function readSpaceMarker(bindingId: string): SpaceReadMarker {
  return { lastSeenSeq: readLastSeen(bindingId), openedAt: readOpenedAt(bindingId) };
}

function onStorage(event: StorageEvent): void {
  if (event.key?.startsWith(LAST_SEEN_PREFIX) || event.key?.startsWith(OPENED_AT_PREFIX)) notify();
}

/** For `useSyncExternalStore`: re-render whenever any space's marker changes. */
export function subscribeReadMarkers(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

export function getReadMarkersVersion(): number {
  return version;
}
