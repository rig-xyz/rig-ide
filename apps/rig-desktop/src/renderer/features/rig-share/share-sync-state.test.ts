import { describe, expect, it } from 'vitest';
import type { RigShareError } from '@shared/rig/rig-share';
import { deriveSharePopoverPhase } from './share-sync-state';

const NOT_BOUND: RigShareError = { kind: 'notBound', message: "This workspace isn't synced to a rig" };
const OFFLINE: RigShareError = { kind: 'relay', message: 'offline' };
const FORBIDDEN: RigShareError = { kind: 'forbidden', message: "You don't have permission." };

describe('deriveSharePopoverPhase', () => {
  it('loading wins over everything else while auth status is still in flight', () => {
    expect(
      deriveSharePopoverPhase({ authLoading: true, signedIn: false, membersError: null })
    ).toEqual({ kind: 'loading' });
    expect(
      deriveSharePopoverPhase({ authLoading: true, signedIn: true, membersError: NOT_BOUND })
    ).toEqual({ kind: 'loading' });
  });

  it('signed out — offers sign-in regardless of the rig\'s own sync state', () => {
    expect(
      deriveSharePopoverPhase({ authLoading: false, signedIn: false, membersError: null })
    ).toEqual({ kind: 'signedOut' });
  });

  it('signed in, local-only rig (members read answers notBound) — the deferred-sync moment', () => {
    expect(
      deriveSharePopoverPhase({ authLoading: false, signedIn: true, membersError: NOT_BOUND })
    ).toEqual({ kind: 'localOnly' });
  });

  it('signed in, offline — a thrown transport error (no status), not a real failure', () => {
    expect(
      deriveSharePopoverPhase({ authLoading: false, signedIn: true, membersError: OFFLINE })
    ).toEqual({ kind: 'offline' });
  });

  it('signed in, some other relay error — surfaced verbatim', () => {
    expect(
      deriveSharePopoverPhase({ authLoading: false, signedIn: true, membersError: FORBIDDEN })
    ).toEqual({ kind: 'error', message: "You don't have permission." });
  });

  it('signed in, already-synced rig, no error — ready (today\'s behavior, unchanged)', () => {
    expect(
      deriveSharePopoverPhase({ authLoading: false, signedIn: true, membersError: null })
    ).toEqual({ kind: 'ready' });
  });
});
