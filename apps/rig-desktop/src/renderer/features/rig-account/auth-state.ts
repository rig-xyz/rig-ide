import type { RigAccountError } from '@shared/rig/account';

/**
 * `auth.status`'s `signedIn` only means "a token file exists on disk" — it
 * says nothing about whether the relay still accepts that token (a
 * signed-in-elsewhere revoke, a stale token left over from a prior
 * account). The account `me` query is the cheap validity signal: when the
 * relay comes back 401 `invalid_token`, the token on disk is dead and the
 * app should treat itself as signed out — the same signed-out gate/sign-in
 * button a fresh install would show, rather than quietly showing "signed
 * in" for an account that can no longer do anything.
 *
 * Pure and exported for direct unit testing — the one place `home.tsx` and
 * `user-pill.tsx` both derive their `signedIn` boolean from, so the two
 * surfaces can't drift into disagreeing about it.
 */
export function deriveSignedIn(authStatusSignedIn: boolean, meError: RigAccountError | undefined): boolean {
  if (!authStatusSignedIn) return false;
  return meError?.kind !== 'invalidToken';
}
