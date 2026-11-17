import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '@main/lib/logger';
import type { GardenerRecord, GardenerStore } from './gardener';

/**
 * The record of the gardener's last pass in each space, in a small JSON file in the app's data
 * folder (not in the space, so it never syncs; not in memory, so the caps survive a restart).
 * Read once, rewritten atomically on every change; an unreadable file means nothing recorded.
 */
export function createFileGardenerStore(filePath: string): GardenerStore {
  let data: Record<string, GardenerRecord> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, GardenerRecord>;
  } catch {
    // No file yet, or unreadable: start empty.
  }
  return {
    get(id) {
      const entry = data[id];
      return entry && typeof entry === 'object' && Array.isArray(entry.starts) ? entry : null;
    },
    set(id, record) {
      data = { ...data, [id]: record };
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameSync(tmp, filePath);
      } catch (error) {
        log.warn('Rig gardener: could not save its record', { error: String(error) });
      }
    },
  };
}
