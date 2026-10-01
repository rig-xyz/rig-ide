import { rpc } from '@renderer/lib/ipc';

/**
 * Tells the relay how far you've read a space (spec §4, Read rules), so
 * unread counts and notifications clear on every device, not just this one.
 *
 * `room-read-marker.ts` stays the instant, local source for the Room's
 * "New" line; this sends the same marker on, debounced per space so a
 * stream of messages while you watch is one request, not one each. `seen`
 * (the space is on screen in a focused window) also clears its run and
 * request rows, which have no message seq.
 */

const DEBOUNCE_MS = 2_000;

type Pending = { seq: number | null; seen: boolean; timer: ReturnType<typeof setTimeout> | null };

const pending = new Map<string, Pending>();

/** The space is on screen and this window has focus right now. */
export function windowIsLooking(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function reportSpaceRead(bindingId: string, input: { seq?: number; seen?: boolean }, immediate = false): void {
  if (!bindingId) return;
  const entry = pending.get(bindingId) ?? { seq: null, seen: false, timer: null };
  if (input.seq !== undefined) entry.seq = Math.max(entry.seq ?? 0, input.seq);
  if (input.seen) entry.seen = true;
  pending.set(bindingId, entry);
  if (immediate) {
    flush(bindingId);
    return;
  }
  if (!entry.timer) entry.timer = setTimeout(() => flush(bindingId), DEBOUNCE_MS);
}

function flush(bindingId: string): void {
  const entry = pending.get(bindingId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(bindingId);
  if (entry.seq === null && !entry.seen) return;
  void rpc.rig.notifications
    .markSpaceRead({
      bindingId,
      ...(entry.seq !== null ? { seq: entry.seq } : {}),
      ...(entry.seen ? { seen: true } : {}),
    })
    .catch(() => {});
}
