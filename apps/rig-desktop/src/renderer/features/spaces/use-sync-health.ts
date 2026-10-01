import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { SyncHealth } from '@shared/rig/sync-health';

/**
 * A folder's sync state on this computer (`rig.syncHealth`, read off its
 * `.rig/` folder by the main process), kept fresh while shown, plus the one
 * action that fixes a problem: start (or resume) syncing.
 *
 * Plain effect polling rather than react-query: the Room renders without a
 * query client in places (and in its tests), and this is one tiny read.
 */

const POLL_MS = 15_000;

async function readHealth(path: string): Promise<SyncHealth | null> {
  try {
    const result = await rpc.rig.syncHealth.get({ paths: [path] });
    return result[path] ?? null;
  } catch {
    return null;
  }
}

export function useSyncHealth(path: string | null): {
  health: SyncHealth | null;
  /** Starts or resumes syncing; the state updates as it goes. */
  start: () => Promise<void>;
} {
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    setHealth(null);
    if (!path) return;
    let alive = true;
    const refresh = () => {
      if (busy.current) return;
      void readHealth(path).then((next) => {
        if (alive && !busy.current && next) setHealth(next);
      });
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [path]);

  const start = useCallback(async () => {
    if (!path || busy.current) return;
    busy.current = true;
    setHealth({ state: 'starting' });
    try {
      const result = await rpc.rig.syncHealth.start({ path });
      setHealth(result.success ? result.data : { state: 'error', message: result.error.message });
    } catch (error) {
      setHealth({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.current = false;
    }
  }, [path]);

  return { health, start };
}
