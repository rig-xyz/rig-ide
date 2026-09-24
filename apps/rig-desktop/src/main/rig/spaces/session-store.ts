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
  type FileShape = { sessions: Record<string, StoredSpaceSession>; inFlight: Record<string, string> };
  let data: FileShape = { sessions: {}, inFlight: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<FileShape> & Record<string, unknown>;
    // Earlier files held the sessions map at the top level.
    data =
      parsed && typeof parsed === 'object' && 'sessions' in parsed
        ? { sessions: parsed.sessions ?? {}, inFlight: parsed.inFlight ?? {} }
        : { sessions: (parsed ?? {}) as Record<string, StoredSpaceSession>, inFlight: {} };
  } catch {
    // No file yet, or unreadable: start empty.
  }

  const save = () => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, filePath);
    } catch (error) {
      log.warn('Rig spaces: could not save space sessions', { error: String(error) });
    }
  };

  return {
    get(key) {
      const entry = data.sessions[key];
      return entry && typeof entry.acpSessionId === 'string' && typeof entry.conversationId === 'string'
        ? entry
        : null;
    },
    set(key, value) {
      data = { ...data, sessions: { ...data.sessions, [key]: value } };
      save();
    },
    markInFlight(runId, bindingId) {
      data = { ...data, inFlight: { ...data.inFlight, [runId]: bindingId } };
      save();
    },
    clearInFlight(runId) {
      if (!(runId in data.inFlight)) return;
      const { [runId]: _cleared, ...rest } = data.inFlight;
      data = { ...data, inFlight: rest };
      save();
    },
    inFlight() {
      return Object.entries(data.inFlight).map(([runId, bindingId]) => ({ runId, bindingId }));
    },
  };
}
