import type { RigSignInPhase } from '@renderer/features/rig-account/use-rig-sign-in';

/**
 * Onboarding-flow spec, Decisions ("Sign-in on Start fresh, option A"): the
 * interactive workspace is relay-bound (comments/sessions/registry key off
 * `bindingId`, which only exists after sync), so a signed-out click on
 * Welcome's "Start fresh" (and the rigs rail's "New rig", which drives the
 * exact same request) can't land in `Start here.md` without signing in
 * first. This is the pure state→copy decision for that button, same
 * reasoning as `share-sync-state.ts`'s own header comment: given (auth
 * status, the in-flight sign-in round-trip, whether a create is running),
 * what does the button show — no fetching/mutation here, that's home.tsx.
 *
 * `signInError` isn't part of the brief's own shorthand name for this
 * function but is required to produce `error`'s `message`: `useRigSignIn`
 * reports it as a field separate from `phase` (phase always settles back to
 * `'idle'` once the round-trip ends, success or not), so it has to be
 * threaded through as its own input.
 */

export type WelcomePhase =
  | { kind: 'idle' }
  | { kind: 'signingIn' }
  | { kind: 'creating' }
  | { kind: 'error'; message: string };

export function deriveWelcomePhase(params: {
  authLoading: boolean;
  signedIn: boolean;
  signInPhase: RigSignInPhase;
  signInError: string | null;
  creating: boolean;
}): WelcomePhase {
  // Creation wins outright: once sign-in succeeds it continues straight into
  // `createRig()` before `useRigSignIn`'s own `finally` resets `phase` to
  // `'idle'`, so without this check first the button would flash back to
  // idle for a render between the two.
  if (params.creating) return { kind: 'creating' };
  if (params.signInPhase !== 'idle') return { kind: 'signingIn' };
  // Auth status still loading, or already signed in: never show a stale
  // sign-in error from a previous attempt — requirement is "no flash of the
  // sign-in line" for a signed-in user, and a signed-in user has no reason
  // to see sign-in copy of any kind, error included.
  if (params.authLoading || params.signedIn) return { kind: 'idle' };
  if (params.signInError) return { kind: 'error', message: params.signInError };
  return { kind: 'idle' };
}
