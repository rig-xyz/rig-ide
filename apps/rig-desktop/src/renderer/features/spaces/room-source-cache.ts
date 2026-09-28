import type { RelayRoomSource } from './relay-room-source';

/**
 * The last few spaces' live Rooms, kept alive behind whichever one is on
 * screen (outside React, so a Room view unmounting doesn't tear its Room
 * down). Re-opening one of them shows its snapshot at once — no skeleton,
 * no refetch of what it already holds — and catches up on the gap.
 *
 * - Keyed by (signed-in user id, binding id). Asking for another account's
 *   Room disposes every Room of the previous one: one account's snapshot is
 *   never served to another. `clear()` on sign-out does the same.
 * - A Room not on screen stops saying you're here or typing
 *   (`RelayRoomSource.setShown`) but keeps listening; after `idleMs` hidden
 *   it closes its socket (the snapshot stays). Shown again, it reconnects
 *   and catches up.
 * - Past `capacity`, the least recently shown hidden Room is disposed.
 */

type Entry = {
  selfUserId: string;
  bindingId: string;
  source: RelayRoomSource;
  /** How many views are showing it now (normally 0 or 1). */
  shown: number;
  hiddenAtMs: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/** One view's hold on a Room: `release()` when that view goes away (idempotent). */
export type RoomLease = {
  source: RelayRoomSource;
  selfUserId: string;
  /** It was already open (kept alive behind other spaces). */
  reused: boolean;
  /** How long it had been hidden, when reused. */
  hiddenMs: number | null;
  release(): void;
};

/** Where the relay is and who you are, from the last connection-info read — so a cached Room can show before it's asked again. */
export type RoomConnectionInfo = { selfUserId: string; wsUrl: string };

export class RoomSourceCache {
  private readonly entries = new Map<string, Entry>();
  private readonly capacity: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private connectionInfo: RoomConnectionInfo | null = null;

  constructor(options: { capacity?: number; idleMs?: number; now?: () => number } = {}) {
    this.capacity = options.capacity ?? 4;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get connection(): RoomConnectionInfo | null {
    return this.connectionInfo;
  }

  rememberConnection(info: RoomConnectionInfo): void {
    if (this.connectionInfo && this.connectionInfo.selfUserId !== info.selfUserId) this.clear();
    this.connectionInfo = info;
  }

  /** The kept-alive Room for this binding, for the last known account — without taking it. */
  peek(bindingId: string): RelayRoomSource | null {
    const selfUserId = this.connectionInfo?.selfUserId;
    return selfUserId ? (this.entries.get(keyOf(selfUserId, bindingId))?.source ?? null) : null;
  }

  /** Shows this binding's Room: the kept-alive one when there is one, else a new one from `create`. */
  acquire(selfUserId: string, bindingId: string, create: () => RelayRoomSource): RoomLease {
    // Another account's Rooms never outlive the switch.
    for (const entry of [...this.entries.values()]) {
      if (entry.selfUserId !== selfUserId) this.dispose(entry);
    }
    const key = keyOf(selfUserId, bindingId);
    let entry = this.entries.get(key);
    const reused = !!entry;
    const hiddenMs = entry?.hiddenAtMs != null ? this.now() - entry.hiddenAtMs : null;
    if (entry) {
      this.entries.delete(key); // re-inserted below: most recently shown last
    } else {
      entry = { selfUserId, bindingId, source: create(), shown: 0, hiddenAtMs: null, idleTimer: null };
    }
    this.entries.set(key, entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.hiddenAtMs = null;
    entry.shown += 1;
    if (entry.shown === 1) {
      entry.source.setShown(true);
      // A new Room starts here; `setShown(true)` on a new one does just that.
      if (!reused) entry.source.play();
    }
    this.evict();

    const held = entry;
    let released = false;
    return {
      source: held.source,
      selfUserId,
      reused,
      hiddenMs,
      release: () => {
        if (released) return;
        released = true;
        this.hide(held);
      },
    };
  }

  /** Disposes this binding's Rooms (the space was deleted or left). */
  forget(bindingId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.bindingId === bindingId) this.dispose(entry);
    }
  }

  /** Disposes every Room and forgets who you are (sign-out). */
  clear(): void {
    for (const entry of [...this.entries.values()]) this.dispose(entry);
    this.connectionInfo = null;
  }

  private hide(entry: Entry): void {
    if (this.entries.get(keyOf(entry.selfUserId, entry.bindingId)) !== entry) return; // already disposed
    entry.shown = Math.max(0, entry.shown - 1);
    if (entry.shown > 0) return;
    entry.source.setShown(false);
    entry.hiddenAtMs = this.now();
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      entry.source.pause(); // the socket closes; the snapshot stays
    }, this.idleMs);
    this.evict();
  }

  /** Oldest hidden first, until back within capacity. A Room on screen is never evicted. */
  private evict(): void {
    for (const entry of [...this.entries.values()]) {
      if (this.entries.size <= this.capacity) return;
      if (entry.shown === 0) this.dispose(entry);
    }
  }

  private dispose(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    this.entries.delete(keyOf(entry.selfUserId, entry.bindingId));
    entry.source.dispose();
  }
}

function keyOf(selfUserId: string, bindingId: string): string {
  return `${selfUserId}\n${bindingId}`;
}

/** The app's one cache — see `RoomSourceCache`. */
export const roomSourceCache = new RoomSourceCache();
