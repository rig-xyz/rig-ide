import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '@main/lib/logger';

/**
 * When this app last started each scheduled view's pass, by `bindingId/view`, in a small JSON file
 * in the app's data folder (not in the space, so it never syncs; not in memory, so a restart does
 * not forget it). Read once, rewritten atomically on every change; an unreadable file means
 * nothing recorded, and the view's data file age stands in (`isViewRefreshDue`).
 */
export function createFileViewPassStore(filePath: string): {
  get(key: string): number | undefined;
  set(key: string, at: number): void;
} {
  let data: Record<string, number> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      );
    }
  } catch {
    // No file yet, or unreadable: start empty.
  }
  return {
    get: (key) => data[key],
    set(key, at) {
      data = { ...data, [key]: at };
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameSync(tmp, filePath);
      } catch (error) {
        log.warn('Rig views: could not save when a pass last started', { error: String(error) });
      }
    },
  };
}
