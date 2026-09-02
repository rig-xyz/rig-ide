import { isOfflineError } from '@renderer/features/docs/comments/comments-cache';
import type { RigShareError } from '@shared/rig/rig-share';

/**
 * Pure derivation of what the rig-level Share popover shows (onboarding-flow
 * spec, Rollout step 2 — "deferred share/sync"): a rig created local-only
 * (no relay binding yet) never asks about sync up front. The Share button's
 * popover is the one moment that's decided, and only when someone actually
 * opens it — never before.
 *
 * `membersError.kind === 'notBound'` is exactly how `rig.share.members`
 * reports a local-only rig (see `main/rig/rig-share.ts`'s `resolveContext`,
 * which returns `NOT_BOUND` before ever reaching the relay) — there is no
 * separate "is this rig synced" read to keep in sync with this one.
 */

export type SharePopoverPhase =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'localOnly' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export function deriveSharePopoverPhase(params: {
  authLoading: boolean;
  signedIn: boolean;
  membersError: RigShareError | null;
}): SharePopoverPhase {
  if (params.authLoading) return { kind: 'loading' };
  if (!params.signedIn) return { kind: 'signedOut' };
  if (params.membersError) {
    if (params.membersError.kind === 'notBound') return { kind: 'localOnly' };
    if (isOfflineError(params.membersError)) return { kind: 'offline' };
    return { kind: 'error', message: params.membersError.message };
  }
  return { kind: 'ready' };
}
