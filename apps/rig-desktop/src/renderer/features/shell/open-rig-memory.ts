/**
 * 0.4.3: a window reload (Cmd+R) used to land on Home instead of the space
 * or rig that was open. The window's open rig is remembered in
 * `sessionStorage` — per window, survives a reload, gone with the window —
 * and `App.tsx` reopens it on load (as a launch restore, so a folder that
 * stopped being a rig falls back to Home). `kind` rides along so a space
 * reopens in its space form from the first frame.
 */

const KEY = 'rig-open-rig';

export type OpenRigMemory = { path: string; kind?: 'space' };

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readOpenRig(storage?: Store): OpenRigMemory | null {
  try {
    const parsed: unknown = JSON.parse((storage ?? window.sessionStorage).getItem(KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const { path, kind } = parsed as Record<string, unknown>;
    if (typeof path !== 'string' || !path) return null;
    return kind === 'space' ? { path, kind } : { path };
  } catch {
    return null;
  }
}

/** `null` forgets it (back on Home). */
export function writeOpenRig(memory: OpenRigMemory | null, storage?: Store): void {
  try {
    const store = storage ?? window.sessionStorage;
    if (memory) store.setItem(KEY, JSON.stringify(memory));
    else store.removeItem(KEY);
  } catch {
    // Storage unavailable — a reload just lands on Home.
  }
}
