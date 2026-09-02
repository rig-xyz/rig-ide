import { describe, expect, it } from 'vitest';
import { deriveUnboundDetection, isForeignAccountRow } from '@shared/rig/workspace';

describe('deriveUnboundDetection', () => {
  it('classifies a rig.toml-bearing folder without a binding as an unsynced rig', () => {
    expect(
      deriveUnboundDetection({
        pickedPath: '/Users/dylan/knee-ability',
        pickedHasRigToml: true,
        pickedName: 'knee-ability',
      })
    ).toEqual({
      bound: false,
      unsynced: { path: '/Users/dylan/knee-ability', name: 'knee-ability' },
      foreignAccount: null,
    });
  });

  it('keeps a plain folder the unchanged not-a-rig outcome', () => {
    expect(
      deriveUnboundDetection({
        pickedPath: '/Users/dylan/random',
        pickedHasRigToml: false,
        pickedName: null,
      })
    ).toEqual({ bound: false, unsynced: null, foreignAccount: null });
  });

  it('tolerates a manifest without a readable name', () => {
    expect(
      deriveUnboundDetection({ pickedPath: '/x', pickedHasRigToml: true, pickedName: null })
    ).toEqual({ bound: false, unsynced: { path: '/x', name: null }, foreignAccount: null });
  });
});

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs") —
 * `workspace.ts`'s `detect` foreign-account gate.
 */
describe('isForeignAccountRow', () => {
  it('no local row at all (existingAccountId undefined) is never foreign, regardless of who is signed in', () => {
    expect(isForeignAccountRow(undefined, { status: 'known', id: 'usr_a' })).toBe(false);
    expect(isForeignAccountRow(undefined, { status: 'signedOut' })).toBe(false);
    expect(isForeignAccountRow(undefined, { status: 'unknown' })).toBe(false);
  });

  it('a legacy row (existingAccountId null) is never foreign — shown to everyone until backfilled', () => {
    expect(isForeignAccountRow(null, { status: 'known', id: 'usr_a' })).toBe(false);
    expect(isForeignAccountRow(null, { status: 'signedOut' })).toBe(false);
  });

  it('signed in as the same account the row was stamped with — not foreign', () => {
    expect(isForeignAccountRow('usr_a', { status: 'known', id: 'usr_a' })).toBe(false);
  });

  it('signed in as a different account than the row was stamped with — foreign', () => {
    expect(isForeignAccountRow('usr_a', { status: 'known', id: 'usr_b' })).toBe(true);
  });

  it('signed out, but the row belongs to a known account — foreign (the honest card, "sign in as that account")', () => {
    expect(isForeignAccountRow('usr_a', { status: 'signedOut' })).toBe(true);
  });

  it("current identity unknown (a relay hiccup) — never foreign, fails open so a network blip can't block someone from their own rig", () => {
    expect(isForeignAccountRow('usr_a', { status: 'unknown' })).toBe(false);
  });
});
