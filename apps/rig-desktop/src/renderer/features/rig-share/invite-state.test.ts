import { describe, expect, it } from 'vitest';
import type { RigInvite, RigMember } from '@shared/rig/rig-share';
import {
  excludeInvitesToMembers,
  isPendingInvite,
  mintedInviteMatchesRole,
  type PendingInvite,
  shapePendingInvites,
  suggestCollaborators,
} from './invite-state';

const NOW = Date.parse('2026-08-15T12:00:00Z');

function invite(overrides: Partial<RigInvite> = {}): RigInvite {
  return {
    id: 'inv_1',
    emailConstraint: null,
    role: 'editor',
    maxUses: null,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    label: null,
    createdAt: '2026-08-14T12:00:00Z',
    ...overrides,
  };
}

describe('isPendingInvite', () => {
  it('accepts a plain active invite (no expiry, no cap, not revoked)', () => {
    expect(isPendingInvite(invite(), NOW)).toBe(true);
  });

  it('drops revoked invites', () => {
    expect(isPendingInvite(invite({ revokedAt: '2026-08-14T13:00:00Z' }), NOW)).toBe(false);
  });

  it('drops expired invites, keeps ones expiring in the future', () => {
    expect(isPendingInvite(invite({ expiresAt: '2026-08-15T11:59:59Z' }), NOW)).toBe(false);
    expect(isPendingInvite(invite({ expiresAt: '2026-08-15T12:00:00Z' }), NOW)).toBe(false);
    expect(isPendingInvite(invite({ expiresAt: '2026-08-16T00:00:00Z' }), NOW)).toBe(true);
  });

  it('drops exhausted invites (useCount reached maxUses), keeps partially used ones', () => {
    expect(isPendingInvite(invite({ maxUses: 1, useCount: 1 }), NOW)).toBe(false);
    expect(isPendingInvite(invite({ maxUses: 2, useCount: 1 }), NOW)).toBe(true);
    // Unlimited uses: useCount alone never exhausts it.
    expect(isPendingInvite(invite({ maxUses: null, useCount: 50 }), NOW)).toBe(true);
  });
});

describe('shapePendingInvites', () => {
  it('filters to pending and maps to display rows, preserving relay order', () => {
    const rows = shapePendingInvites(
      [
        invite({ id: 'a', emailConstraint: 'ada@example.com', role: 'viewer' }),
        invite({ id: 'b', revokedAt: '2026-08-14T13:00:00Z' }),
        invite({ id: 'c', emailConstraint: null, role: 'editor' }),
      ],
      NOW
    );
    expect(rows).toEqual([
      { id: 'a', email: 'ada@example.com', roleLabel: 'viewer', createdAt: '2026-08-14T12:00:00Z' },
      { id: 'c', email: null, roleLabel: 'editor', createdAt: '2026-08-14T12:00:00Z' },
    ]);
  });

  it('labels a pure-capability invite (role null) as `link`', () => {
    const rows = shapePendingInvites([invite({ role: null })], NOW);
    expect(rows[0]?.roleLabel).toBe('link');
  });

  it('returns an empty list when nothing is pending', () => {
    expect(
      shapePendingInvites([invite({ revokedAt: '2026-08-14T13:00:00Z' })], NOW)
    ).toEqual([]);
  });
});

describe('mintedInviteMatchesRole', () => {
  it('true when the minted link\'s own role still matches the current selection', () => {
    expect(mintedInviteMatchesRole('editor', 'editor')).toBe(true);
    expect(mintedInviteMatchesRole('viewer', 'viewer')).toBe(true);
  });

  it('false the moment the role toggle no longer matches what was minted — the stale-link bug', () => {
    expect(mintedInviteMatchesRole('editor', 'viewer')).toBe(false);
    expect(mintedInviteMatchesRole('viewer', 'editor')).toBe(false);
  });

  it('false for a null minted role (a pure-capability link) against any real role selection', () => {
    expect(mintedInviteMatchesRole(null, 'editor')).toBe(false);
  });
});

describe('excludeInvitesToMembers', () => {
  function member(overrides: Partial<RigMember> = {}): RigMember {
    return {
      userId: 'u_1',
      name: 'Sam',
      email: 'sam@example.com',
      avatarUrl: null,
      role: 'editor',
      ...overrides,
    };
  }

  function pending(email: string | null, overrides: Partial<PendingInvite> = {}): PendingInvite {
    return { id: 'inv_1', email, roleLabel: 'editor', createdAt: '2026-08-14T12:00:00Z', ...overrides };
  }

  it('drops a pending invite whose email belongs to a current member — Sam joined another way', () => {
    const sam = member({ email: 'sam@example.com' });
    expect(excludeInvitesToMembers([pending('sam@example.com')], [sam])).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const sam = member({ email: 'sam@example.com' });
    expect(excludeInvitesToMembers([pending('SAM@Example.com')], [sam])).toEqual([]);
  });

  it('keeps an open-link invite (no email) regardless of membership', () => {
    const sam = member({ email: 'sam@example.com' });
    const link = pending(null);
    expect(excludeInvitesToMembers([link], [sam])).toEqual([link]);
  });

  it('keeps an invite addressed to someone who is not (yet) a member', () => {
    const sam = member({ email: 'sam@example.com' });
    const forBob = pending('bob@example.com');
    expect(excludeInvitesToMembers([forBob], [sam])).toEqual([forBob]);
  });

  it('is a no-op when there are no members with an email on file', () => {
    const noEmail = member({ email: null });
    const forBob = pending('bob@example.com');
    expect(excludeInvitesToMembers([forBob], [noEmail])).toEqual([forBob]);
  });
});

describe('suggestCollaborators', () => {
  function member(overrides: Partial<RigMember> = {}): RigMember {
    return {
      userId: 'u_1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      avatarUrl: null,
      role: 'editor',
      ...overrides,
    };
  }

  it('returns collaborators as-is with an empty query', () => {
    const ada = member();
    const bob = member({ userId: 'u_2', name: 'Bob', email: 'bob@example.com' });
    expect(suggestCollaborators([ada, bob], new Set(), '')).toEqual([ada, bob]);
  });

  it('excludes anyone already a member of the current rig', () => {
    const ada = member();
    const bob = member({ userId: 'u_2', name: 'Bob', email: 'bob@example.com' });
    expect(suggestCollaborators([ada, bob], new Set(['u_1']), '')).toEqual([bob]);
  });

  it('drops collaborators with no email — nothing for a click to fill the field with', () => {
    const noEmail = member({ userId: 'u_3', email: null });
    expect(suggestCollaborators([noEmail], new Set(), '')).toEqual([]);
  });

  it('filters case-insensitively against name or email', () => {
    const ada = member();
    const bob = member({ userId: 'u_2', name: 'Bob', email: 'bob@example.com' });
    expect(suggestCollaborators([ada, bob], new Set(), 'ADA')).toEqual([ada]);
    expect(suggestCollaborators([ada, bob], new Set(), 'example.com')).toEqual([ada, bob]);
    expect(suggestCollaborators([ada, bob], new Set(), 'nobody')).toEqual([]);
  });

  it('matches a null name against the query by falling back to nothing (not throwing) and still matching on email', () => {
    const noName = member({ userId: 'u_4', name: null, email: 'noname@example.com' });
    expect(suggestCollaborators([noName], new Set(), 'noname')).toEqual([noName]);
  });

  it('caps results at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      member({ userId: `u_${i}`, name: `Person ${i}`, email: `p${i}@example.com` })
    );
    expect(suggestCollaborators(many, new Set(), '', 6)).toHaveLength(6);
  });
});
