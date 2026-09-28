import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRoomCache } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  cachedRoomSchema,
  ROOM_CACHE_FORMAT_VERSION,
  ROOM_CACHE_MAX_BYTES,
  ROOM_CACHE_MAX_SPACES,
  type CachedRoomBlob,
} from '@shared/spaces/room-cache';
import { resolveRelayUrl } from './account';
import { forgetLocalCaches, localCacheAccountId, purgeLocalCaches } from './local-cache-account';

/**
 * `rig_room_cache` (rig/docs/room-disk-cache-spec.md): each space's last
 * Room, per account, so the first open after launch shows it at once. The
 * renderer builds and restores the blob (`RelayRoomSource`); this module
 * only stores it, gates it to the signed-in account and the current relay,
 * caps it, and forgets it. Every failure reads as "nothing cached" — a cold
 * open, never an error.
 */

function relayHost(): string {
  try {
    return new URL(resolveRelayUrl()).host;
  } catch {
    return '';
  }
}

/** Parses a stored or incoming blob; null when it isn't one this build writes (another format, or broken). */
function parseBlob(value: unknown): CachedRoomBlob | null {
  const parsed = cachedRoomSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function dropRow(accountId: string, bindingId: string, reason: string): Promise<void> {
  log.info('Rig spaces: room cache discard', { bindingId, reason });
  await db
    .delete(rigRoomCache)
    .where(and(eq(rigRoomCache.accountId, accountId), eq(rigRoomCache.bindingId, bindingId)))
    .catch(() => undefined);
}

/** Keeps at most `ROOM_CACHE_MAX_SPACES` rows, dropping the least recently opened. */
async function evict(): Promise<void> {
  const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)` }).from(rigRoomCache);
  const over = count - ROOM_CACHE_MAX_SPACES;
  if (over <= 0) return;
  const oldest = await db
    .select({ accountId: rigRoomCache.accountId, bindingId: rigRoomCache.bindingId, bytes: rigRoomCache.bytes })
    .from(rigRoomCache)
    .orderBy(asc(rigRoomCache.openedAt))
    .limit(over);
  for (const row of oldest) {
    await db
      .delete(rigRoomCache)
      .where(and(eq(rigRoomCache.accountId, row.accountId), eq(rigRoomCache.bindingId, row.bindingId)));
  }
  log.info('Rig spaces: room cache evict', { count: oldest.length, bytes: oldest.reduce((n, r) => n + r.bytes, 0) });
}

export const rigRoomCacheController = createRPCController({
  /** This space's cached Room for the signed-in account on the current relay, or null. Never asks the relay. */
  get: async ({ bindingId }: { bindingId: string }): Promise<CachedRoomBlob | null> => {
    try {
      const accountId = await localCacheAccountId();
      if (!accountId) return null;
      const [row] = await db
        .select()
        .from(rigRoomCache)
        .where(and(eq(rigRoomCache.accountId, accountId), eq(rigRoomCache.bindingId, bindingId)))
        .limit(1);
      if (!row) return null;
      if (row.formatVersion !== ROOM_CACHE_FORMAT_VERSION) {
        await dropRow(accountId, bindingId, 'version');
        return null;
      }
      if (row.relayHost !== relayHost()) {
        await dropRow(accountId, bindingId, 'relay');
        return null;
      }
      let blob: CachedRoomBlob | null = null;
      try {
        blob = parseBlob(JSON.parse(row.snapshotJson));
      } catch {
        blob = null;
      }
      if (!blob || blob.relayHost !== row.relayHost) {
        await dropRow(accountId, bindingId, 'parse');
        return null;
      }
      await db
        .update(rigRoomCache)
        .set({ openedAt: Date.now() })
        .where(and(eq(rigRoomCache.accountId, accountId), eq(rigRoomCache.bindingId, bindingId)));
      return blob;
    } catch (error) {
      log.warn('Rig spaces: could not read the room cache', { bindingId, error: String(error) });
      return null;
    }
  },

  /**
   * Saves this space's Room for `selfUserId` — refused unless that's the
   * account signed in now. The blob is re-validated here (a finished run's
   * summary keeps only its hide-safe fields; anything else is stripped) and
   * stamped with the current relay. Over the size cap, nothing is written.
   */
  put: async ({
    bindingId,
    selfUserId,
    blob,
  }: {
    bindingId: string;
    selfUserId: string;
    blob: unknown;
  }): Promise<{ saved: boolean; bytes: number }> => {
    try {
      const accountId = await localCacheAccountId();
      if (!accountId || accountId !== selfUserId) return { saved: false, bytes: 0 };
      const host = relayHost();
      const parsed = parseBlob(blob);
      if (!parsed || !host) return { saved: false, bytes: 0 };
      const snapshotJson = JSON.stringify({ ...parsed, relayHost: host });
      const bytes = Buffer.byteLength(snapshotJson);
      if (bytes > ROOM_CACHE_MAX_BYTES) {
        log.info('Rig spaces: room cache discard', { bindingId, reason: 'size', bytes });
        return { saved: false, bytes };
      }
      const now = Date.now();
      const values = {
        relayHost: host,
        formatVersion: ROOM_CACHE_FORMAT_VERSION,
        snapshotJson,
        bytes,
        savedAt: parsed.savedAt,
        openedAt: now,
      };
      await db
        .insert(rigRoomCache)
        .values({ accountId, bindingId, ...values })
        .onConflictDoUpdate({ target: [rigRoomCache.accountId, rigRoomCache.bindingId], set: values });
      await evict();
      return { saved: true, bytes };
    } catch (error) {
      log.warn('Rig spaces: could not write the room cache', { bindingId, error: String(error) });
      return { saved: false, bytes: 0 };
    }
  },

  /** Forgets one space (deleted, left, or no longer yours) — its cached Room and comment threads, for every account. */
  forget: async ({ bindingId }: { bindingId: string }): Promise<void> => {
    await forgetLocalCaches(bindingId);
  },

  /** Forgets every cached Room and comment thread. */
  clear: async (): Promise<void> => {
    await purgeLocalCaches();
  },
});
