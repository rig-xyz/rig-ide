import { describe, expect, it } from 'vitest';
import type { RigAccountError } from '@shared/rig/account';
import { deriveSignedIn } from './auth-state';

describe('deriveSignedIn', () => {
  it('is false when auth.status itself says signed out, regardless of the me query', () => {
    expect(deriveSignedIn(false, undefined)).toBe(false);
    expect(deriveSignedIn(false, { kind: 'invalidToken', message: 'x' })).toBe(false);
  });

  it('is true when auth.status says signed in and the me query has not errored', () => {
    expect(deriveSignedIn(true, undefined)).toBe(true);
  });

  it('downgrades to signed out when the me query reports a rejected token (401 invalid_token)', () => {
    expect(deriveSignedIn(true, { kind: 'invalidToken', message: 'expired' })).toBe(false);
  });

  it('stays signed in for any other me-query error kind — a rejected token is the only downgrade signal', () => {
    const errors: RigAccountError[] = [
      { kind: 'notSignedIn', message: 'x' },
      { kind: 'untrustedRelay', host: 'evil.example', message: 'x' },
      { kind: 'relay', status: 500, message: 'x' },
      { kind: 'relay', status: 404, message: 'x' },
      { kind: 'relay', message: 'transport failure' },
    ];
    for (const error of errors) {
      expect(deriveSignedIn(true, error)).toBe(true);
    }
  });
});
