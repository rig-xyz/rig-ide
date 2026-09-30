import { useSyncExternalStore } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigSpaceSetupChannel, type SpaceSetup, type SpaceSetupEvent } from '@shared/rig/space-setup';
import { moveComposerDraft } from './components/composer';

/**
 * The renderer's view of main's background space setups
 * (`main/rig/space-setup.ts`): one shared store, so App (the Room being set
 * up) and Home (its "Setting up…" row) read the same thing. Seeded from
 * `rig.spaceSetup.list()` (a reload mid-setup still sees it) and kept
 * current by `rigSpaceSetupChannel`.
 *
 * "New space" goes through `startSpaceSetup` from anywhere (Home's pill,
 * the space switcher): it starts the setup and asks App to open its Room
 * (`onOpenSetupRequest`), without threading a callback through each caller.
 */

let setups: ReadonlyMap<string, SpaceSetup> = new Map();
const listeners = new Set<() => void>();
const openListeners = new Set<(id: string) => void>();
let attached = false;

/** Where a space's composer keeps its draft while it has no binding id yet. */
export function setupDraftKey(id: string): string {
  return `setup:${id}`;
}

function notify() {
  for (const listener of listeners) listener();
}

/** Applies one setup's new state (from main's event, or a `start`/`retry` answer). Exported for tests. */
export function applySpaceSetup(event: SpaceSetupEvent): void {
  const next = new Map(setups);
  if (event.removed) next.delete(event.id);
  else {
    const { removed: _removed, ...setup } = event;
    next.set(setup.id, setup);
    // Live: whatever was typed in the Room meanwhile waits in the space's own message box.
    if (setup.status === 'live' && setup.bindingId) moveComposerDraft(setupDraftKey(setup.id), setup.bindingId);
  }
  setups = next;
  notify();
}

function attach() {
  if (attached) return;
  attached = true;
  try {
    events.on(rigSpaceSetupChannel, applySpaceSetup);
    void rpc.rig.spaceSetup
      .list()
      .then((list) => {
        // Events that arrived meanwhile are newer: only fill in what's missing.
        const missing = list.filter((setup) => !setups.has(setup.id));
        if (missing.length === 0) return;
        const next = new Map(setups);
        for (const setup of missing) next.set(setup.id, setup);
        setups = next;
        notify();
      })
      .catch(() => {});
  } catch {
    // No IPC (tests): the store just starts empty.
  }
}

function subscribe(listener: () => void): () => void {
  attach();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => setups;

/** Every setup this app session started (working, failed, or live). */
export function useSpaceSetups(): ReadonlyMap<string, SpaceSetup> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Asks App to show a setup's Room. */
export function requestOpenSetup(id: string): void {
  for (const listener of openListeners) listener(id);
}

export function onOpenSetupRequest(listener: (id: string) => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/**
 * "New space": starts the setup in main (it returns once the folder
 * exists) and opens its Room right away. Resolves to an error message to
 * show where the click happened, or null.
 */
export async function startSpaceSetup(name: string): Promise<string | null> {
  attach();
  const result = await rpc.rig.spaceSetup.start({ name }).catch((error: unknown) => ({
    success: false as const,
    error: { message: error instanceof Error ? error.message : 'Could not start the space.' },
  }));
  if (!result.success) return result.error.message;
  applySpaceSetup(result.data);
  requestOpenSetup(result.data.id);
  return null;
}

export async function retrySpaceSetup(id: string): Promise<void> {
  const next = await rpc.rig.spaceSetup.retry({ id }).catch(() => null);
  if (next) applySpaceSetup(next);
}

/** Forgets a failed setup (and deletes its folder when nothing usable was made). */
export async function removeSpaceSetup(id: string): Promise<{ removedFolder: boolean } | null> {
  const removed = await rpc.rig.spaceSetup.remove({ id }).catch(() => null);
  const setup = setups.get(id);
  if (removed && setup) applySpaceSetup({ ...setup, removed: true });
  return removed;
}
