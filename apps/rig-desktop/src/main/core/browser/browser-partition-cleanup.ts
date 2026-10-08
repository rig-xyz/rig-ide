import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import { BROWSER_PARTITION_PREFIX } from '@shared/browser';
import { RIG_PAGES_PARTITION } from '@shared/spaces/links';
import { RIG_FILES_PARTITION } from '@shared/spaces/rig-file';

const PERSIST_PREFIX = 'persist:';
const LEGACY_DIR_PREFIX = `${BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length)}-`;
const PROFILE_DIR_PREFIX = `${BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length)}-profile`;
const ISOLATED_DIR_PREFIX = `${BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length)}-isolated-`;
/** Rig's own browsers keep people's page sign-ins; never a legacy tab partition. */
const KEEP_DIRS = new Set([RIG_PAGES_PARTITION, RIG_FILES_PARTITION].map((p) => p.slice(PERSIST_PREFIX.length)));

/**
 * Browsers used to get one persistent partition per browser tab. Keep named
 * profile and isolated-task partitions, but remove old unused tab partitions so
 * stale cookies and caches do not accumulate in userData/Partitions.
 */
export async function cleanupLegacyBrowserPartitions(partitionsDir = join(app.getPath('userData'), 'Partitions')): Promise<void> {
  let entries;
  try {
    entries = await readdir(partitionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(LEGACY_DIR_PREFIX)) continue;
    if (KEEP_DIRS.has(entry.name) || entry.name.startsWith(PROFILE_DIR_PREFIX) || entry.name.startsWith(ISOLATED_DIR_PREFIX)) {
      continue;
    }
    try {
      await rm(join(partitionsDir, entry.name), { recursive: true, force: true });
    } catch (error) {
      log.warn('Failed to remove legacy browser partition', { partition: entry.name, error });
    }
  }
}
