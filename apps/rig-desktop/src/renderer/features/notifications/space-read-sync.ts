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

type Pending = {
  seq: number | null;
  seen: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Failed sends so far; the next retry waits longer. */
  attempts: number;
};

/** 4 s, 8 s, 16 s… capped at a minute. */
export function readRetryDelayMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** attempts);
}

const pending = new Map<string, Pending>();

/** The space is on screen and this window has focus right now. */
export function windowIsLooking(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function reportSpaceRead(bindingId: string, input: { seq?: number; seen?: boolean }, immediate = false): void {
  if (!bindingId) return;
  const entry = pending.get(bindingId) ?? { seq: null, seen: false, timer: null, attempts: 0 };
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
  const sent = { seq: entry.seq, seen: entry.seen };
  const retry = () => requeue(bindingId, sent, entry.attempts + 1);
  void rpc.rig.notifications
    .markSpaceRead({
      bindingId,
      ...(sent.seq !== null ? { seq: sent.seq } : {}),
      ...(sent.seen ? { seen: true } : {}),
    })
    .then((result) => {
      if (result.success) return;
      // The relay refused this cursor (a 4xx, e.g. past its newest
      // message): sending it again won't change the answer. Anything else
      // (unreachable, 5xx) is an outage, and the read waits it out.
      const status = result.error.status;
      if (status !== undefined && status >= 400 && status < 500) return;
      retry();
    })
    .catch(retry);
}

/**
 * A send that didn't land goes back in the queue, merged with anything
 * newer, and tries again later, for as long as the app runs (backoff caps
 * at a minute): otherwise this computer would say "read" while the relay
 * and other devices never hear it.
 */
function requeue(bindingId: string, sent: { seq: number | null; seen: boolean }, attempts: number): void {
  // Only the cursor is retried: the relay stamps `seen` with its own clock,
  // so a late retry would clear run rows that arrived after the person
  // looked. The next time the window comes back to the Room sends it anew.
  if (sent.seq === null) return;
  const entry = pending.get(bindingId) ?? { seq: null, seen: false, timer: null, attempts: 0 };
  entry.seq = Math.max(entry.seq ?? 0, sent.seq);
  entry.attempts = Math.max(entry.attempts, attempts);
  pending.set(bindingId, entry);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flush(bindingId), readRetryDelayMs(attempts));
}
