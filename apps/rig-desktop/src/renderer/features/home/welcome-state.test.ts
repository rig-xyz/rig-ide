import { describe, expect, it } from 'vitest';
import { deriveWelcomePhase } from './welcome-state';

describe('deriveWelcomePhase', () => {
  it('signed-in, auth resolved, nothing in flight — idle (today\'s one-click behavior, unchanged)', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: true,
        signInPhase: 'idle',
        signInError: null,
        creating: false,
      })
    ).toEqual({ kind: 'idle' });
  });

  it('signed-out, auth resolved, nothing in flight — idle (button is live, click starts sign-in)', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: false,
        signInPhase: 'idle',
        signInError: null,
        creating: false,
      })
    ).toEqual({ kind: 'idle' });
  });

  it('auth status still loading — idle regardless of signed-in guess, no copy flash', () => {
    expect(
      deriveWelcomePhase({
        authLoading: true,
        signedIn: false,
        signInPhase: 'idle',
        signInError: null,
        creating: false,
      })
    ).toEqual({ kind: 'idle' });
  });

  it('sign-in round-trip starting — signingIn', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: false,
        signInPhase: 'starting',
        signInError: null,
        creating: false,
      })
    ).toEqual({ kind: 'signingIn' });
  });

  it('sign-in round-trip waiting on the browser — signingIn (same copy as starting)', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: false,
        signInPhase: 'waiting',
        signInError: null,
        creating: false,
      })
    ).toEqual({ kind: 'signingIn' });
  });

  it('sign-in failed or was cancelled — back to idle button, but with the honest error message', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: false,
        signInPhase: 'idle',
        signInError: "Couldn't complete sign-in. Try again.",
        creating: false,
      })
    ).toEqual({ kind: 'error', message: "Couldn't complete sign-in. Try again." });
  });

  it('sign-in landed and creation is already running — creating wins over the stale error', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: true,
        signInPhase: 'idle',
        signInError: "Couldn't complete sign-in. Try again.",
        creating: true,
      })
    ).toEqual({ kind: 'creating' });
  });

  it('creating wins even mid-round-trip (defensive — the two never actually overlap in practice)', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: false,
        signInPhase: 'waiting',
        signInError: null,
        creating: true,
      })
    ).toEqual({ kind: 'creating' });
  });

  it('signed in but a leftover error from a previous attempt lingers — idle clears it, never shown', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: true,
        signInPhase: 'idle',
        signInError: "Couldn't complete sign-in. Try again.",
        creating: false,
      })
    ).toEqual({ kind: 'idle' });
  });

  it('signed-in one-click create in flight — creating', () => {
    expect(
      deriveWelcomePhase({
        authLoading: false,
        signedIn: true,
        signInPhase: 'idle',
        signInError: null,
        creating: true,
      })
    ).toEqual({ kind: 'creating' });
  });
});
