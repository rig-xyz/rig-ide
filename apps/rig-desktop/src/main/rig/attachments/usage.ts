import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACHMENTS_DIR } from '@shared/rig/attachments';

/**
 * How much of the space's 50 MB quota is in use, for the pre-send check.
 *
 * The relay's quota counts the size of every current file in the space's
 * manifest (tap `sumLiveBytes`). The same manifest is readable by any member
 * (`GET /v1/me/bindings/:id/manifest`, already used for rig membership
 * reads), so that's the primary source: its sizes summed, plus attachments
 * sitting in this computer's `attachments/` folder that the manifest doesn't
 * have yet (sent a moment ago, not synced yet). Offline, the sync daemon's
 * own state (`.rig/tap/state.local.db`, a JSON file of the paths it has
 * synced) is the fallback: those files' sizes on disk plus the same
 * not-yet-synced attachments.
 */

export type ManifestSize = { path: string; size: number | null };

export type SpaceUsage = { usedBytes: number; source: 'relay' | 'local' };

export type UsageDeps = {
  /** Every current (non-deleted) manifest entry, or null when the relay can't be reached. */
  fetchManifest: (bindingId: string) => Promise<ManifestSize[] | null>;
};

const TAPD_STATE = join('.rig', 'tap', 'state.local.db');

/** Paths the sync daemon has synced here (keys of its state file), or null when there's no readable state. */
export async function readSyncedPaths(root: string): Promise<Map<string, { hash: string | null; dirty: boolean }> | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, TAPD_STATE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { paths?: Record<string, { lastSeenHash?: unknown; localDirty?: unknown }> };
    if (!parsed || typeof parsed.paths !== 'object' || parsed.paths === null) return null;
    const out = new Map<string, { hash: string | null; dirty: boolean }>();
    for (const [path, record] of Object.entries(parsed.paths)) {
      out.set(path, {
        hash: typeof record?.lastSeenHash === 'string' ? record.lastSeenHash : null,
        dirty: record?.localDirty === true,
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Files directly in `attachments/`, as space-relative paths with their sizes. */
async function localAttachments(root: string): Promise<Array<{ path: string; size: number }>> {
  let names: string[];
  try {
    names = await readdir(join(root, ATTACHMENTS_DIR));
  } catch {
    return [];
  }
  const out: Array<{ path: string; size: number }> = [];
  for (const name of names) {
    const size = await sizeOf(join(root, ATTACHMENTS_DIR, name));
    if (size > 0) out.push({ path: `${ATTACHMENTS_DIR}/${name}`, size });
  }
  return out;
}

/** Current usage, or null when neither the relay nor local sync state can tell. */
export async function spaceUsage(deps: UsageDeps, bindingId: string, root: string): Promise<SpaceUsage | null> {
  const pending = await localAttachments(root);
  const manifest = await deps.fetchManifest(bindingId).catch(() => null);
  if (manifest) {
    const known = new Set(manifest.map((entry) => entry.path));
    const used = manifest.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    const unsynced = pending.filter((file) => !known.has(file.path)).reduce((sum, file) => sum + file.size, 0);
    return { usedBytes: used + unsynced, source: 'relay' };
  }
  const synced = await readSyncedPaths(root);
  if (!synced) return null;
  let used = 0;
  for (const path of synced.keys()) used += await sizeOf(join(root, ...path.split('/')));
  const unsynced = pending.filter((file) => !synced.has(file.path)).reduce((sum, file) => sum + file.size, 0);
  return { usedBytes: used + unsynced, source: 'local' };
}
