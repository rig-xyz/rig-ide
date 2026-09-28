import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRoomCache } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigOfflineHomeSnapshot } from '@shared/rig/offline-home';
import { readRememberedWorkspaces } from './local-cache-account';

/**
 * Home's offline read: the signed-in account's last known spaces and when
 * each one's chat was last saved here. Local only — never asks the relay —
 * and never returns another account's data (`localCacheAccountId` is the
 * gate for both parts).
 */
export async function offlineHomeSnapshot(): Promise<RigOfflineHomeSnapshot> {
  const { accountId, workspaces } = await readRememberedWorkspaces();
  const roomSavedAt: Record<string, number> = {};
  if (accountId) {
    try {
      const rows = await db
        .select({ bindingId: rigRoomCache.bindingId, savedAt: rigRoomCache.savedAt })
        .from(rigRoomCache)
        .where(eq(rigRoomCache.accountId, accountId));
      for (const row of rows) roomSavedAt[row.bindingId] = row.savedAt;
    } catch (error) {
      log.warn('Rig offline home: could not read the room cache', { error: String(error) });
    }
  }
  return { accountId, workspaces, roomSavedAt };
}

export const rigOfflineController = createRPCController({
  homeSnapshot: (): Promise<RigOfflineHomeSnapshot> => offlineHomeSnapshot(),
});
