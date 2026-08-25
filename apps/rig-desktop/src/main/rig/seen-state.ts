import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRigs, rigSeenFiles } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { events } from '@main/lib/events';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigSeenStateChangedChannel, type SeenMap } from '@shared/rig/seen-state';

/**
 * `rig_seen_files` reads/writes — the seen-state store behind the file
 * navigator's unseen dots (`docs/file-navigator-design.md` §4). Local only,
 * never synced: this table has no relation to anything the `rig` CLI or the
 * relay touches. See `shared/rig/seen-state.ts` for the pure unseen-summary
 * math this data feeds.
 */

/** The rig's own "first seen locally" moment — `rig_rigs.first_opened_at` doubles as the never-viewed baseline (see `shared/rig/seen-state.ts`'s header comment). Falls back to now (nothing flagged unseen) if the rig row genuinely isn't known yet — defensive only, `recordRigOpened` always runs before the workspace screen can mount. */
async function getBaseline(bindingId: string): Promise<number> {
  const [row] = await db
    .select({ firstOpenedAt: rigRigs.firstOpenedAt })
    .from(rigRigs)
    .where(eq(rigRigs.bindingId, bindingId))
    .limit(1);
  if (!row) {
    log.warn('Rig seen-state: no rig_rigs row for bindingId — baseline defaults to now', { bindingId });
    return Date.now();
  }
  return row.firstOpenedAt;
}

export const rigSeenStateController = createRPCController({
  /** The tree's own baseline + every known last-viewed timestamp for this rig, in one round trip. */
  getState: async ({ bindingId }: { bindingId: string }): Promise<{ baselineAt: number; seen: SeenMap }> => {
    const [baselineAt, rows] = await Promise.all([
      getBaseline(bindingId),
      db
        .select({ relPath: rigSeenFiles.relPath, lastViewedAt: rigSeenFiles.lastViewedAt })
        .from(rigSeenFiles)
        .where(eq(rigSeenFiles.bindingId, bindingId)),
    ]);
    const seen: SeenMap = {};
    for (const row of rows) seen[row.relPath] = row.lastViewedAt;
    return { baselineAt, seen };
  },

  /** A file was opened — clears its unseen dot from now on. */
  markSeen: async ({ bindingId, relPath }: { bindingId: string; relPath: string }): Promise<void> => {
    const now = Date.now();
    await db
      .insert(rigSeenFiles)
      .values({ bindingId, relPath, lastViewedAt: now })
      .onConflictDoUpdate({
        target: [rigSeenFiles.bindingId, rigSeenFiles.relPath],
        set: { lastViewedAt: now },
      });
    events.emit(rigSeenStateChangedChannel, { bindingId });
  },

  /** "Mark all as seen" — every relPath the caller currently has listed for this rig. */
  markAllSeen: async ({ bindingId, relPaths }: { bindingId: string; relPaths: string[] }): Promise<void> => {
    if (relPaths.length === 0) return;
    const now = Date.now();
    db.transaction((tx) => {
      for (const relPath of relPaths) {
        tx.insert(rigSeenFiles)
          .values({ bindingId, relPath, lastViewedAt: now })
          .onConflictDoUpdate({
            target: [rigSeenFiles.bindingId, rigSeenFiles.relPath],
            set: { lastViewedAt: now },
          })
          .run();
      }
    });
    events.emit(rigSeenStateChangedChannel, { bindingId });
  },

  /**
   * Ghost-row cleanup: a path that no longer exists (deleted, renamed) has
   * nothing to be "unseen" about — called once per tree load with the
   * FULL current listing, not on every live-update refetch (cheap, not
   * chatty). An empty `existingRelPaths` means the rig currently lists no
   * files at all, so every stored row for it is stale.
   */
  sweep: async ({ bindingId, existingRelPaths }: { bindingId: string; existingRelPaths: string[] }): Promise<void> => {
    if (existingRelPaths.length === 0) {
      await db.delete(rigSeenFiles).where(eq(rigSeenFiles.bindingId, bindingId));
      return;
    }
    await db
      .delete(rigSeenFiles)
      .where(and(eq(rigSeenFiles.bindingId, bindingId), notInArray(rigSeenFiles.relPath, existingRelPaths)));
  },
});
