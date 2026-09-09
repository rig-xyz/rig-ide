import { describe, expect, it } from 'vitest';
import type { RigMyInvite } from '@shared/rig/rig-share';
import {
  deriveBellState,
  emptyInvitesMessage,
  MY_INVITES_KEY_PREFIX,
  myInvitesQueryKey,
  shapeMyInvites,
} from './invites-inbox';

function invite(overrides: Partial<RigMyInvite> = {}): RigMyInvite {
  return {
    id: 'inv_1',
    role: 'editor',
    createdAt: '2026-08-14T12:00:00Z',
    expiresAt: null,
    binding: { id: 'bind_1', name: 'knee-ability-rig' },
    inviter: { name: 'Dylan', email: 'dylan@example.com', avatarUrl: null },
    ...overrides,
  };
}

describe('shapeMyInvites', () => {
  it('maps an invite to its display row', () => {
    expect(shapeMyInvites([invite()])).toEqual([
      {
        id: 'inv_1',
        bindingId: 'bind_1',
        rigName: 'knee-ability-rig',
        inviterLabel: 'Dylan',
        roleLabel: 'editor',
        createdAt: '2026-08-14T12:00:00Z',
      },
    ]);
  });

  it('falls back through inviter name → email → placeholder', () => {
    expect(
      shapeMyInvites([invite({ inviter: { name: null, email: 'a@b.co', avatarUrl: null } })])[0]
        ?.inviterLabel
    ).toBe('a@b.co');
    expect(
      shapeMyInvites([invite({ inviter: { name: null, email: null, avatarUrl: null } })])[0]
        ?.inviterLabel
    ).toBe('Someone');
  });

  it('names an unnamed or blank-named rig honestly and coerces a missing role', () => {
    expect(
      shapeMyInvites([invite({ binding: { id: 'b', name: null }, role: null })])[0]
    ).toMatchObject({ rigName: 'Unnamed rig', roleLabel: 'member' });
    expect(shapeMyInvites([invite({ binding: { id: 'b', name: '  ' } })])[0]?.rigName).toBe(
      'Unnamed rig'
    );
  });

  it('preserves relay order (newest first) without re-sorting', () => {
    const rows = shapeMyInvites([invite({ id: 'newer' }), invite({ id: 'older' })]);
    expect(rows.map((r) => r.id)).toEqual(['newer', 'older']);
  });
});

describe('deriveBellState', () => {
  it('never shows the bell signed out, regardless of count', () => {
    expect(deriveBellState(false, 3)).toEqual({ visible: false, count: 0 });
    expect(deriveBellState(false, null)).toEqual({ visible: false, count: 0 });
  });

  it('shows the bell signed in, with the pending count', () => {
    expect(deriveBellState(true, 2)).toEqual({ visible: true, count: 2 });
  });

  it('treats an unknown count (list not loaded) as zero — bell without a dot', () => {
    expect(deriveBellState(true, null)).toEqual({ visible: true, count: 0 });
    expect(deriveBellState(true, 0)).toEqual({ visible: true, count: 0 });
  });
});

/**
 * Feedback round fix: the old bare `['rig','share','myInvites']` key had no
 * account dimension, so a query fetched while signed in as one account
 * could still be shown, cached, after a DIFFERENT account signed in —
 * exactly the "invited hugo@orchardstreet.xyz, signed in as that email,
 * bell says 'No pending invites'" report. Keying on the account id makes a
 * different account a structurally different cache entry.
 */
describe('myInvitesQueryKey', () => {
  it('two different accounts get two different keys', () => {
    expect(myInvitesQueryKey('usr_a')).not.toEqual(myInvitesQueryKey('usr_b'));
  });

  it('the same account always gets the same key', () => {
    expect(myInvitesQueryKey('usr_a')).toEqual(myInvitesQueryKey('usr_a'));
  });

  it('signed-out/unresolved (null) is its own distinct key, not equal to any account id', () => {
    expect(myInvitesQueryKey(null)).toEqual([...MY_INVITES_KEY_PREFIX, null]);
    expect(myInvitesQueryKey(null)).not.toEqual(myInvitesQueryKey('usr_a'));
  });

  it('every key shares the same prefix, so a prefix invalidate still matches it', () => {
    expect(myInvitesQueryKey('usr_a').slice(0, MY_INVITES_KEY_PREFIX.length)).toEqual([
      ...MY_INVITES_KEY_PREFIX,
    ]);
  });
});

describe('emptyInvitesMessage', () => {
  it('names the signed-in email so an address mismatch is self-explanatory', () => {
    expect(emptyInvitesMessage('hugo@orchardstreet.xyz')).toBe(
      'No pending invites for hugo@orchardstreet.xyz.'
    );
  });

  it('falls back to the plain copy when the email is not known', () => {
    expect(emptyInvitesMessage(null)).toBe('No pending invites.');
  });
});
