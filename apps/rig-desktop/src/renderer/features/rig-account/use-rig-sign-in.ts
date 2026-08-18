import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { rpc } from '@renderer/lib/ipc';

/**
 * Drives `rig login`: start it, open the URL it prints, and wait for it to
 * finish. Ported from emdash's `useRigSignIn` — the onboarding-flow-specific
 * bits (the sidebar identity chip, the Settings empty state) don't exist in
 * this app yet, but the comments margin's sign-in prompt needs the same hook,
 * so it's kept as its own reusable piece rather than inlined there.
 */

export type RigSignInPhase = 'idle' | 'starting' | 'waiting';

export function useRigSignIn(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  // Guards against a stale `awaitLogin()` resolving after the caller has
  // unmounted or the reader has cancelled.
  const skippedRef = useRef(false);
  const [phase, setPhase] = useState<RigSignInPhase>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    skippedRef.current = false;
    setError(null);
    setUrl(null);
    setPhase('starting');

    const started = await rpc.rig.auth.login();
    if (skippedRef.current) return;
    if (!started.success) {
      setError(started.error.message);
      setPhase('idle');
      return;
    }
    setPhase('waiting');
    if (started.data.url) {
      setUrl(started.data.url);
      confirmOpenExternalLink(started.data.url);
    }

    const finished = await rpc.rig.auth.awaitLogin();
    if (skippedRef.current) return;
    if (!finished.success) {
      setError(finished.error.message);
      setPhase('idle');
      return;
    }

    setPhase('idle');
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
    onSuccess?.();
  }, [onSuccess, queryClient]);

  const cancel = useCallback(() => {
    skippedRef.current = true;
    void rpc.rig.auth.cancel();
    setPhase('idle');
  }, []);

  return { phase, url, error, signIn, cancel };
}
