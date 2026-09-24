import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '@main/lib/logger';
import type { SpaceSessionStore, StoredSpaceSession } from './dispatch';

/**
 * Remembers each persistent space session (one per space, owner and agent)
 * in a small JSON file, so an app restart resumes the agent's own session
 * instead of starting it from nothing. Read once, rewritten atomically on
 * every change; a missing or unreadable file just means "nothing to resume".
 */
export function createFileSpaceSessionStore(filePath: string): SpaceSessionStore {
  let entries: Record<string, StoredSpaceSession> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object') entries = parsed as Record<string, StoredSpaceSession>;
  } catch {
    // No file yet, or unreadable: start empty.
  }

  return {
    get(key) {
      const entry = entries[key];
      return entry && typeof entry.acpSessionId === 'string' && typeof entry.conversationId === 'string'
        ? entry
        : null;
    },
    set(key, value) {
      entries = { ...entries, [key]: value };
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(entries, null, 2));
        renameSync(tmp, filePath);
      } catch (error) {
        log.warn('Rig spaces: could not save space sessions', { error: String(error) });
      }
    },
  };
}
