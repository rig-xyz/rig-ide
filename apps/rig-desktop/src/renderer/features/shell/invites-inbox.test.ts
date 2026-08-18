import { describe, expect, it } from 'vitest';
import type { RigMyInvite } from '@shared/rig/rig-share';
import { deriveBellState, shapeMyInvites } from './invites-inbox';

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
