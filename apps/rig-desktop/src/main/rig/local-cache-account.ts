import { createHash } from 'node:crypto';
import { eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { rigCommentsCache, rigRoomCache } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { RigWorkspaceBinding } from '@shared/rig/account';
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
/**
 * The account's last `GET /v1/me/bindings` answer, so Home can still list
 * its spaces while the relay is out of reach. Same account/relay gate as the
 * Room cache; purged with it.
 */
type RememberedWorkspaces = {
  accountId: string;
  relayHost: string;
  savedAt: number;
  bindings: RigWorkspaceBinding[];
};
const memory = new KV<{ account: Remembered; workspaces: RememberedWorkspaces }>('rig-local-cache');
/** Home's layout cache (`home-layout.ts`); its namespace, repeated here so purging never imports the sync. */
const homeLayoutMemory = new KV<{ state: { account: string } }>('rig-home-layout');
/** Home's recent themes cache (`recent-themes.ts`), likewise. */
const recentThemesMemory = new KV<{ state: { account: string } }>('rig-recent-themes');

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

async function currentRelayHost(): Promise<string | null> {
  const ctx = await resolveContext();
  if (isError(ctx)) return null;
  try {
    return new URL(ctx.url).host;
  } catch {
    return null;
  }
}

/** Keeps the account's workspace list for offline use. Best-effort; never stored without a known account. */
export async function rememberWorkspaces(bindings: readonly RigWorkspaceBinding[]): Promise<void> {
  try {
    const accountId = await localCacheAccountId();
    const relayHost = await currentRelayHost();
    if (!accountId || !relayHost) return;
    await memory.set('workspaces', { accountId, relayHost, savedAt: Date.now(), bindings: [...bindings] });
  } catch (error) {
    log.warn('Rig local caches: could not remember workspaces', { error: String(error) });
  }
}

/** The signed-in account's last known workspace list on the current relay, or null. Never asks the relay. */
export async function readRememberedWorkspaces(): Promise<{
  accountId: string | null;
  workspaces: { savedAt: number; bindings: RigWorkspaceBinding[] } | null;
}> {
  try {
    const accountId = await localCacheAccountId();
    if (!accountId) return { accountId: null, workspaces: null };
    const stored = await memory.get('workspaces');
    const relayHost = await currentRelayHost();
    if (!stored || stored.accountId !== accountId || stored.relayHost !== relayHost) {
      return { accountId, workspaces: null };
    }
    return { accountId, workspaces: { savedAt: stored.savedAt, bindings: stored.bindings } };
  } catch (error) {
    log.warn('Rig local caches: could not read remembered workspaces', { error: String(error) });
    return { accountId: null, workspaces: null };
  }
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
      const workspaces = await memory.get('workspaces');
      if (workspaces && workspaces.accountId !== keep) await memory.del('workspaces');
      const layout = await homeLayoutMemory.get('state');
      if (layout && !layout.account.startsWith(`${keep}@`)) await homeLayoutMemory.del('state');
      const themes = await recentThemesMemory.get('state');
      if (themes && !themes.account.startsWith(`${keep}@`)) await recentThemesMemory.del('state');
    } else {
      await db.delete(rigRoomCache);
      await db.delete(rigCommentsCache);
      await memory.del('account');
      await memory.del('workspaces');
      await homeLayoutMemory.del('state');
      await recentThemesMemory.del('state');
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
    const workspaces = await memory.get('workspaces');
    if (workspaces?.bindings.some((b) => b.id === bindingId)) {
      await memory.set('workspaces', { ...workspaces, bindings: workspaces.bindings.filter((b) => b.id !== bindingId) });
    }
  } catch (error) {
    log.warn('Rig local caches: could not forget a space', { bindingId, error: String(error) });
  }
}
