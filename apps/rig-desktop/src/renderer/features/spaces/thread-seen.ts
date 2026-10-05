/**
 * Threads view: the newest reply you've seen in each thread, on this
 * computer (localStorage, `rig-room-*` key convention, every access in
 * try/catch). Opening a thread marks it seen; a thread never opened here
 * counts from where you'd read the space when you came in (`readLastSeen`).
 */

const PREFIX = 'rig-room-thread-seen:';

function key(bindingId: string, rootId: string): string {
  return `${PREFIX}${bindingId}:${rootId}`;
}

export function readThreadSeen(bindingId: string, rootId: string): number | null {
  try {
    const raw = localStorage.getItem(key(bindingId, rootId));
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Never moves back. Returns whether it changed. */
export function writeThreadSeen(bindingId: string, rootId: string, seq: number): boolean {
  const current = readThreadSeen(bindingId, rootId);
  if (current !== null && current >= seq) return false;
  try {
    localStorage.setItem(key(bindingId, rootId), String(seq));
    return true;
  } catch {
    return false;
  }
}
