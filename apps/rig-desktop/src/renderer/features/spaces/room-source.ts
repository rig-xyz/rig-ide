/**
 * Spaces (lane 2): `RoomSource` is the transport-agnostic contract the Room
 * UI is built against. `FixtureRoomSource` replays a scripted feed
 * (`fixtures/room-feed.ts`) with timing, entirely in-memory — no relay
 * dependency. Lane 3's `RelayRoomSource` (not built here) should satisfy
 * the same interface, backed by the room's real event stream instead of a
 * script; see `NOTES.md` for the contract this assumes from the relay.
 */

import type { RoomEvent, RoomSnapshot } from './types';

export interface RoomSource {
  /** The current materialized state — always safe to call, even before anything has played. */
  getSnapshot(): RoomSnapshot;
  /** Notified with (event, snapshotAfterEvent) for every event applied, including ones applied by `replayAll`. Returns an unsubscribe function. */
  subscribe(listener: (event: RoomEvent, snapshot: RoomSnapshot) => void): () => void;
  /** Starts (or resumes) timed replay of the scripted feed. No-op if already playing or fully replayed. */
  play(): void;
  /** Pauses timed replay; `play()` resumes from where it left off. */
  pause(): void;
  isPlaying(): boolean;
  /** True once every scripted event has been applied. */
  isDone(): boolean;
  /** Applies every remaining event synchronously, no timers — for tests and the "jump to end" dev affordance. */
  replayAll(): void;
  /** Stops any pending timers. Call on unmount. */
  dispose(): void;
  /**
   * Scrollback: loads the page before the oldest message (see
   * `RoomSnapshot.olderMessages`). Absent for a source with none.
   */
  loadOlder?(): Promise<void>;
}

export interface RoomFeedBeat {
  /** Delay before this beat's events are applied, relative to the previous beat (ms, at 1x speed). */
  delayMs: number;
  events: RoomEvent[];
}

export interface RoomFeedScript {
  initialSnapshot: RoomSnapshot;
  beats: RoomFeedBeat[];
  /** Pure reducer: applies one event to a snapshot, returning the next snapshot. Lives with the script because only the script author knows what each event means for its own initial state's shape. */
  reduce: (snapshot: RoomSnapshot, event: RoomEvent) => RoomSnapshot;
}

type Listener = (event: RoomEvent, snapshot: RoomSnapshot) => void;

/**
 * Replays `script.beats` in order, each after its own `delayMs` (divided by
 * `speed`), notifying subscribers as it goes. `getSnapshot()` always
 * returns the latest materialized state, so a component that mounts mid-
 * replay (or never subscribes at all) still renders correctly.
 */
export class FixtureRoomSource implements RoomSource {
  private snapshot: RoomSnapshot;
  private readonly beats: RoomFeedBeat[];
  private readonly reduce: RoomFeedScript['reduce'];
  private readonly speed: number;
  private nextBeatIndex = 0;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();

  constructor(script: RoomFeedScript, options: { speed?: number } = {}) {
    this.snapshot = script.initialSnapshot;
    this.beats = script.beats;
    this.reduce = script.reduce;
    this.speed = options.speed ?? 1;
  }

  getSnapshot(): RoomSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isDone(): boolean {
    return this.nextBeatIndex >= this.beats.length;
  }

  play(): void {
    if (this.playing || this.isDone()) return;
    this.playing = true;
    this.scheduleNext();
  }

  pause(): void {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  replayAll(): void {
    this.pause();
    while (this.nextBeatIndex < this.beats.length) {
      this.applyBeat(this.beats[this.nextBeatIndex]);
      this.nextBeatIndex += 1;
    }
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }

  private scheduleNext(): void {
    if (!this.playing || this.isDone()) {
      this.playing = false;
      return;
    }
    const beat = this.beats[this.nextBeatIndex];
    const delay = Math.max(0, beat.delayMs / this.speed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.applyBeat(beat);
      this.nextBeatIndex += 1;
      this.scheduleNext();
    }, delay);
  }

  private applyBeat(beat: RoomFeedBeat): void {
    for (const event of beat.events) {
      this.snapshot = this.reduce(this.snapshot, event);
      for (const listener of this.listeners) listener(event, this.snapshot);
    }
  }
}
