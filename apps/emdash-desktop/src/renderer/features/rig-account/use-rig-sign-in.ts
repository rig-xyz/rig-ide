import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';

/**
 * Drives `rig login` the same way `RigSignInStep` (onboarding) does — start
 * it, open the URL it prints, and wait for it to finish — factored out so
 * every other surface that can start sign-in (the sidebar identity chip, the
 * Settings → Workspaces empty state, the comments margin's sign-in prompt)
 * shares one implementation instead of three copies of it.
 *
 * On success, invalidates the `rig` account/auth queries so every signed-in
 * surface built on `useQuery` picks up the new state without a restart.
 * Callers that hold their own non-react-query state (the doc comments mobx
 * store) pass `onSuccess` to react as well.
 */

export type RigSignInPhase = 'idle' | 'starting' | 'waiting';

export function useRigSignIn(onSuccess?: () => void) {
  const queryClient = useQueryClient();
  // Guards against a stale `awaitLogin()` resolving after the caller has
  // unmounted or the reader has cancelled — same guard `RigSignInStep` uses.
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
