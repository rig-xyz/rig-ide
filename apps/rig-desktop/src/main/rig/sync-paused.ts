import { readFile, writeFile } from 'node:fs/promises';
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

/**
 * Delete-a-rig round: stamps a `reason` onto `.rig/sync-paused.json` right
 * after `rig pause` has already written its own `{paused: true, pausedAt}`
 * (the CLI's own `writeSyncPaused` in `collab.mjs` — no `reason` field,
 * and no CLI flag to pass one through) — `main/rig/rig-controls.ts`'s
 * `stopSyncForDeletion` calls this as a best-effort follow-up write, so a
 * rig being deleted/left records WHY it stopped syncing, mirroring the
 * relay lane's own `reason: 'deleted'` (tapd stopping itself on a 410).
 * Preserves the `pausedAt` `rig pause` just wrote when it can read it back;
 * falls back to a fresh timestamp otherwise (missing/malformed file) — same
 * tolerant default `isRigSyncPaused` uses.
 */
export async function writeSyncPausedReason(rigPath: string, reason: string): Promise<void> {
  const file = joinPath(rigPath, '.rig', 'sync-paused.json');
  let pausedAt = new Date().toISOString();
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const existing = (parsed as Record<string, unknown>).pausedAt;
      if (typeof existing === 'string') pausedAt = existing;
    }
  } catch {
    // missing/malformed — a fresh pausedAt is the honest fallback.
  }
  await writeFile(file, `${JSON.stringify({ paused: true, pausedAt, reason }, null, 2)}\n`, 'utf8');
}
