import { events } from '@main/lib/events';
import { rigSpaceStateChannel } from '@shared/rig/space-state';
import { createSpaceStateStore } from './space-state';

/** One emit per space per this long, so a busy turn does not flood the windows. */
const EMIT_EVERY_MS = 250;

const lastEmit = new Map<string, number>();
const pending = new Map<string, NodeJS.Timeout>();

function emit(bindingId: string): void {
  lastEmit.set(bindingId, Date.now());
  events.emit(rigSpaceStateChannel, spaceState.get(bindingId));
}

/** Trailing throttle: the first change goes out now, the rest of a burst as one emit after the window. */
function onChange(bindingId: string): void {
  if (pending.has(bindingId)) return;
  const wait = EMIT_EVERY_MS - (Date.now() - (lastEmit.get(bindingId) ?? 0));
  if (wait <= 0) {
    emit(bindingId);
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(bindingId);
    emit(bindingId);
  }, wait);
  timer.unref?.();
  pending.set(bindingId, timer);
}

/** This Mac's runtime facts about each space's standing work and turns (`space-state.ts`). */
export const spaceState = createSpaceStateStore({ now: Date.now, onChange });
