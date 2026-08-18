import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigCommentsCache } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigCommentMessage, RigCommentsCacheEntry } from '@shared/rig/comments';
import { resolveCommentTarget } from './comments';

/**
 * `rig_comments_cache` reads/writes — graduated from `comments-store.ts`'s
 * `docs:comments-cache:*` localStorage blob (`persistence-design.md` Round A).
 *
 * Kept in its own module, separate from `comments.ts`, purely for
 * testability: `comments.ts` is imported directly (not through
 * `rigCommentsController`) by `comments.test.ts`'s plain-Node resolution
 * tests specifically because it has no `@main/db/client` import chain —
 * see that file's own header comment, and `comment-agent.ts` for the
 * existing precedent of splitting a DB-touching surface out the same way.
 * `rpc.ts` merges this back into the same `rig.comments.*` RPC namespace,
 * so the split is invisible to callers.
 */
export const rigCommentsCacheController = createRPCController({
  /**
   * The last-synced snapshot for this file, if one was ever cached. Keyed by
   * `absPath` like every other comments method; the bindingId/relPath the
   * table actually keys on are resolved server-side, same as `list`/`create`,
   * so the renderer never needs to know them. Null when unbound or nothing
   * has ever synced.
   */
  cacheGet: async ({ absPath }: { absPath: string }): Promise<RigCommentsCacheEntry | null> => {
    const target = resolveCommentTarget(absPath);
    if (!target) return null;
    try {
      const [row] = await db
        .select()
        .from(rigCommentsCache)
        .where(
          and(
            eq(rigCommentsCache.bindingId, target.bindingId),
            eq(rigCommentsCache.relPath, target.relPath)
          )
        )
        .limit(1);
      if (!row) return null;
      const messages: unknown = JSON.parse(row.threadsJson);
      if (!Array.isArray(messages)) return null;
      return {
        bindingId: row.bindingId,
        relPath: row.relPath,
        lastSyncedAt: new Date(row.syncedAt).toISOString(),
        messages: messages as RigCommentMessage[],
      };
    } catch (error) {
      log.warn('Rig comments: failed to read the comments cache', { absPath, error: String(error) });
      return null;
    }
  },

  /**
   * Write-through counterpart to `cacheGet`, called after every successful
   * `list` read. Best-effort — a write failure must never surface as a
   * comments error, since the cache is a convenience for offline viewing,
   * not the source of truth.
   */
  cacheSet: async ({
    absPath,
    messages,
    lastSyncedAt,
  }: {
    absPath: string;
    messages: RigCommentMessage[];
    lastSyncedAt: string;
  }): Promise<void> => {
    const target = resolveCommentTarget(absPath);
    if (!target) return;
    const parsed = Date.parse(lastSyncedAt);
    const syncedAt = Number.isFinite(parsed) ? parsed : Date.now();
    const threadsJson = JSON.stringify(messages);
    try {
      await db
        .insert(rigCommentsCache)
        .values({ bindingId: target.bindingId, relPath: target.relPath, threadsJson, syncedAt })
        .onConflictDoUpdate({
          target: [rigCommentsCache.bindingId, rigCommentsCache.relPath],
          set: { threadsJson, syncedAt },
        });
    } catch (error) {
      log.warn('Rig comments: failed to write the comments cache', { absPath, error: String(error) });
    }
  },
});
