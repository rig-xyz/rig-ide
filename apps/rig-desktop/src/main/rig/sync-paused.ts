import { readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

/**
 * `.rig/sync-paused.json`'s `paused` flag for a rig at `rigPath` — the
 * same file rig's own `rig pause`/`rig resume` persist and `tapd start`
 * gates on (see docs/rig-home-design.md, "Per-rig sync toggle"). False for
 * "missing", "unreadable", or "malformed" — the same tolerant default the
 * CLI's own `isSyncPaused` uses.
 *
 * Its own module (not folded into `home.ts` or `rig-controls.ts`):
 * `recent-rigs.ts` needs this to enrich `recentRigs()`'s rows, and
 * `rig-controls.ts` needs it to verify what `rig pause`/`rig resume`
 * actually did — importing either FROM the other would cycle back through
 * `recent-rigs.ts`'s own `updateRigPath` export.
 */
export async function isRigSyncPaused(rigPath: string): Promise<boolean> {
  try {
    const raw = await readFile(joinPath(rigPath, '.rig', 'sync-paused.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).paused === true;
  } catch {
    return false;
  }
}
