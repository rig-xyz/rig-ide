import { join } from 'node:path';
import { app } from 'electron';
import type { SpaceSessionStore } from './dispatch';
import { createFileSpaceSessionStore } from './session-store';

let sessionStore: SpaceSessionStore | null = null;

/** One store for the file: the dispatcher reads and writes it, a folder move asks it what's running. */
export function spaceSessionStore(): SpaceSessionStore {
  sessionStore ??= createFileSpaceSessionStore(
    join(app.getPath('userData'), 'spaces-sessions.json')
  );
  return sessionStore;
}

/** Whether one of this space's runs is in flight on this computer, so its folder must not move under it. */
export function spaceHasRunInFlight(bindingId: string): boolean {
  return (spaceSessionStore().inFlight?.() ?? []).some((run) => run.bindingId === bindingId);
}
