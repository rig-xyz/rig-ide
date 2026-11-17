import { useSyncExternalStore } from 'react';
import type { RoomSnapshot } from './types';

/**
 * The live Room of each open space, for surfaces outside it. The Room publishes its own snapshot
 * here as it changes; the tabs rail reads it to say what is running in the space while a view,
 * not the Room, fills the window.
 */
const rooms = new Map<string, RoomSnapshot>();
const listeners = new Set<() => void>();

export function publishRoomStatus(bindingId: string, snapshot: RoomSnapshot | null): void {
  if (snapshot) rooms.set(bindingId, snapshot);
  else rooms.delete(bindingId);
  for (const listener of listeners) listener();
}

export function useRoomStatus(bindingId: string): RoomSnapshot | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => rooms.get(bindingId) ?? null
  );
}
