import { realpath } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRigs, rigSeenFiles } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { rigSeenStateChangedChannel } from '@shared/rig/seen-state';
import type { RigSettingsStore } from './settings';

/**
 * Local state keyed by a file's rig-relative path (pins in settings, seen
 * markers in `rig_seen_files`) follows the file when it is renamed through
 * `rig.files.rename`, so a pinned file stays pinned and a read one stays
 * read. Wired to the rename at boot (`index.ts` → `onRigEntryMoved`), so
 * every caller of the RPC gets it.
 */

/** `path` after `from` was renamed to `to`: the entry itself or anything inside it (a folder); null when unaffected. */
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/** Every binding whose recorded folder is this root. `rig_rigs.path` is the last-opened path, so compare canonically. */
async function bindingIdsAt(canonicalRoot: string): Promise<string[]> {
  const rows = await db.select({ path: rigRigs.path, bindingId: rigRigs.bindingId }).from(rigRigs);
  const matches: string[] = [];
  for (const row of rows) {
    const resolved = await realpath(row.path).catch(() => row.path);
    if (resolved === canonicalRoot) matches.push(row.bindingId);
  }
  return matches;
}

function movePins(
  settings: Pick<RigSettingsStore, 'get' | 'set'>,
  bindingId: string,
  from: string,
  to: string
) {
  const pins = settings.get().pinnedPathsByRig[bindingId];
  if (!pins) return;
  let changed = false;
  const next = pins.map((pin) => {
    const moved = movedPath(pin, from, to);
    if (moved === null) return pin;
    changed = true;
    return moved;
  });
  if (changed) settings.set({ pinnedPathsByRig: { [bindingId]: next } });
}

async function moveSeen(bindingId: string, from: string, to: string) {
  const rows = await db
    .select({ relPath: rigSeenFiles.relPath, lastViewedAt: rigSeenFiles.lastViewedAt })
    .from(rigSeenFiles)
    .where(eq(rigSeenFiles.bindingId, bindingId));
  const moves = rows.flatMap((row) => {
    const moved = movedPath(row.relPath, from, to);
    return moved === null ? [] : [{ ...row, moved }];
  });
  if (moves.length === 0) return;
  db.transaction((tx) => {
    for (const { relPath, moved, lastViewedAt } of moves) {
      tx.delete(rigSeenFiles)
        .where(and(eq(rigSeenFiles.bindingId, bindingId), eq(rigSeenFiles.relPath, relPath)))
        .run();
      tx.insert(rigSeenFiles)
        .values({ bindingId, relPath: moved, lastViewedAt })
        .onConflictDoUpdate({
          target: [rigSeenFiles.bindingId, rigSeenFiles.relPath],
          set: { lastViewedAt },
        })
        .run();
    }
  });
  events.emit(rigSeenStateChangedChannel, { bindingId });
}

/** The rename listener: moves pins and seen markers from `from` to `to` for every binding on this root. Never throws. */
export function createEntryMoveFollower(settings: Pick<RigSettingsStore, 'get' | 'set'>) {
  return async ({
    canonicalRoot,
    from,
    to,
  }: {
    canonicalRoot: string;
    from: string;
    to: string;
  }) => {
    if (from === to) return;
    try {
      for (const bindingId of await bindingIdsAt(canonicalRoot)) {
        movePins(settings, bindingId, from, to);
        await moveSeen(bindingId, from, to);
      }
    } catch (error) {
      log.warn('Rig files: pins and seen markers did not follow a rename', {
        error: String(error),
      });
    }
  };
}
