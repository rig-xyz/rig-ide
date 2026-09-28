import { createHash } from 'node:crypto';
import { eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { rigCommentsCache, rigRoomCache } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { isError, peekSelfUserId, resolveContext } from './account';

/**
 * Whose local caches these are: the Room cache (`rig_room_cache`) and the
 * doc comments cache (`rig_comments_cache`) only ever serve the account that
 * wrote them, and are purged on sign-out and whenever another account signs
 * in (rig/docs/room-disk-cache-spec.md, "Privacy and security").
 *
 * The account is the signed-in user id, known once `/v1/me` has answered
 * for the current token (`peekSelfUserId`). This never asks the relay
 * itself, so a cache read never waits on the network: offline, the id last
 * seen for this same token (a fingerprint of it — never the token) is used.
 */

type Remembered = { fingerprint: string; accountId: string };
const memory = new KV<{ account: Remembered }>('rig-local-cache');

/** The account these caches belong to right now, or null (signed out, or not known yet for this token). */
export async function localCacheAccountId(): Promise<string | null> {
  const ctx = await resolveContext();
  if (isError(ctx)) return null;
  const fingerprint = createHash('sha256').update(`${ctx.url}\n${ctx.token}`).digest('hex');
  const remembered = await memory.get('account').catch(() => null);
  const known = await peekSelfUserId();
  if (!known) return remembered?.fingerprint === fingerprint ? remembered.accountId : null;
  if (remembered?.accountId !== known || remembered.fingerprint !== fingerprint) {
    // Another account signed in since these were written: none of theirs stays.
    if (remembered && remembered.accountId !== known) await purgeLocalCaches({ keepAccountId: known });
    await memory.set('account', { fingerprint, accountId: known });
  }
  return known;
}

/**
 * Deletes cached Rooms and comment threads: every account's on sign-out
 * (no `keepAccountId`), or every account's but this one's on a switch.
 * Best-effort — a failure is logged, never thrown into sign-in or sign-out.
 */
export async function purgeLocalCaches(options: { keepAccountId?: string } = {}): Promise<void> {
  const keep = options.keepAccountId;
  try {
    if (keep) {
      await db.delete(rigRoomCache).where(ne(rigRoomCache.accountId, keep));
      await db
        .delete(rigCommentsCache)
        .where(or(isNull(rigCommentsCache.accountId), ne(rigCommentsCache.accountId, keep)));
    } else {
      await db.delete(rigRoomCache);
      await db.delete(rigCommentsCache);
      await memory.del('account');
    }
  } catch (error) {
    log.warn('Rig local caches: could not purge', { error: String(error) });
  }
}

/** Deletes one space's cached Room and comment threads, for every account (deleted, left, or no longer yours). */
export async function forgetLocalCaches(bindingId: string): Promise<void> {
  try {
    await db.delete(rigRoomCache).where(eq(rigRoomCache.bindingId, bindingId));
    await db.delete(rigCommentsCache).where(eq(rigCommentsCache.bindingId, bindingId));
  } catch (error) {
    log.warn('Rig local caches: could not forget a space', { bindingId, error: String(error) });
  }
}
