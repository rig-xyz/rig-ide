import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { reconnectDelayMs } from '@renderer/features/home/home-connection';

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** `navigator.onLine`, live. False means no network at all; true only means "maybe". */
export function useNavigatorOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  );
}

/** True once `active` has stayed true for `afterMs` — the "still connecting" hint's timer. */
export function useWaitedLong(active: boolean, afterMs: number): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!active) {
      setWaited(false);
      return;
    }
    const timer = setTimeout(() => setWaited(true), afterMs);
    return () => clearTimeout(timer);
  }, [active, afterMs]);
  return active && waited;
}

/**
 * Re-runs `retry` while the connection is down: on a backoff timer when
 * `autoRetry` (the relay unreachable — pointless with no network at all),
 * the moment the network comes back, and on "Try again". `retrying` is true
 * while a retry is in flight, for the banner's quiet "Reconnecting…".
 */
export function useAutoReconnect({
  down,
  autoRetry,
  retry,
}: {
  down: boolean;
  autoRetry: boolean;
  retry: () => Promise<unknown>;
}): { retrying: boolean; tryAgain: () => void } {
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const retryRef = useRef(retry);
  retryRef.current = retry;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    try {
      await retryRef.current();
    } catch {
      // A failed retry just waits for the next one.
    } finally {
      inFlight.current = false;
      setRetrying(false);
      setAttempt((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    if (!down) setAttempt(0);
  }, [down]);

  useEffect(() => {
    if (!down || !autoRetry || retrying) return;
    const timer = setTimeout(() => void run(), reconnectDelayMs(attempt));
    return () => clearTimeout(timer);
  }, [down, autoRetry, retrying, attempt, run]);

  useEffect(() => {
    if (!down) return;
    const onOnline = () => void run();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [down, run]);

  return { retrying, tryAgain: () => void run() };
}
