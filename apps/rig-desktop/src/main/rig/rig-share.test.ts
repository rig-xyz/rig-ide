import { describe, expect, it } from 'vitest';
import { deriveSelfRole, toEmailOutcome, toInvite, toMyInvite } from './rig-share';

// Realistic id shapes: the relay's members rows carry BOTH a tap user id
// (`userId`, a uuid) and the Clerk id (`clerkUserId`, `user_…`); `GET /v1/me`
// reports the Clerk id. The regression this file pins down: matching the tap
// id against the Clerk id silently derives no role and hides owner UI.
const OWNER = {
  userId: '6f1d2c3b-4a5e-4f60-9b7a-1c2d3e4f5a6b',
  clerkUserId: 'user_2ZxKneeAbilityOwner01',
  role: 'owner',
  email: 'dylan@example.com',
  name: 'Dylan',
  imageUrl: null,
  joinedAt: '2026-07-01T00:00:00Z',
};
const EDITOR = {
  userId: 'a0b1c2d3-e4f5-4678-9abc-def012345678',
  clerkUserId: 'user_2ZxCollaborator00042',
  role: 'editor',
  email: 'ada@example.com',
  name: 'Ada',
  imageUrl: null,
  joinedAt: '2026-07-02T00:00:00Z',
};

describe('deriveSelfRole', () => {
  it('matches /v1/me’s CLERK id against the row’s clerkUserId — never the tap userId plane', () => {
    expect(deriveSelfRole([OWNER, EDITOR], OWNER.clerkUserId)).toBe('owner');
    expect(deriveSelfRole([OWNER, EDITOR], EDITOR.clerkUserId)).toBe('editor');
    // The buggy comparison: an owner's TAP id looked up as if it were a
    // Clerk id must not match a DIFFERENT person — and a Clerk id must
    // never be missed just because tap ids were compared instead.
    expect(deriveSelfRole([OWNER, EDITOR], 'user_2ZxSomeoneElse0000000')).toBeNull();
  });

  it('falls back to a userId match, in case a future relay unifies the id planes', () => {
    const unified = { userId: 'user_2ZxUnifiedPlane00001', role: 'viewer' };
    expect(deriveSelfRole([unified], 'user_2ZxUnifiedPlane00001')).toBe('viewer');
  });

  it('returns null when the self id is unknown or matches nothing', () => {
    expect(deriveSelfRole([OWNER, EDITOR], null)).toBeNull();
    expect(deriveSelfRole([], OWNER.clerkUserId)).toBeNull();
  });

  it('tolerates malformed rows and a matching row without a role string', () => {
    const roleless = { clerkUserId: 'user_2ZxNoRoleYet0000000', role: 42 };
    expect(deriveSelfRole([null, 'junk', roleless], 'user_2ZxNoRoleYet0000000')).toBeNull();
  });
});

describe('toInvite', () => {
  it('coerces a full relay invite row', () => {
    expect(
      toInvite({
        id: 'inv_1',
        emailConstraint: 'ada@example.com',
        role: 'editor',
        maxUses: 1,
        useCount: 0,
        expiresAt: null,
        revokedAt: null,
        label: null,
        createdAt: '2026-08-14T12:00:00Z',
      })
    ).toEqual({
      id: 'inv_1',
      emailConstraint: 'ada@example.com',
      role: 'editor',
      maxUses: 1,
      useCount: 0,
      expiresAt: null,
      revokedAt: null,
      label: null,
      createdAt: '2026-08-14T12:00:00Z',
    });
  });

  it('rejects rows without a string id, defaults the rest', () => {
    expect(toInvite({ role: 'editor' })).toBeNull();
    expect(toInvite(null)).toBeNull();
    const minimal = toInvite({ id: 'inv_2' });
    expect(minimal).toEqual({
      id: 'inv_2',
      emailConstraint: null,
      role: null,
      maxUses: null,
      useCount: 0,
      expiresAt: null,
      revokedAt: null,
      label: null,
      createdAt: '',
    });
  });
});

describe('toMyInvite', () => {
  it('coerces a full invitee-plane invite (GET /v1/me/invites row)', () => {
    expect(
      toMyInvite({
        id: 'inv_9',
        role: 'editor',
        ops: ['read', 'write', 'subscribe'],
        expiresAt: null,
        createdAt: '2026-08-15T09:00:00Z',
        binding: { id: 'bind_1', name: 'knee-ability-rig' },
        inviter: { name: 'Dylan', email: 'dylan@example.com', avatarUrl: null },
      })
    ).toEqual({
      id: 'inv_9',
      role: 'editor',
      createdAt: '2026-08-15T09:00:00Z',
      expiresAt: null,
      binding: { id: 'bind_1', name: 'knee-ability-rig' },
      inviter: { name: 'Dylan', email: 'dylan@example.com', avatarUrl: null },
    });
  });

  it('requires an id AND a binding id — the row is unrenderable without either', () => {
    expect(toMyInvite({ role: 'editor', binding: { id: 'b' } })).toBeNull();
    expect(toMyInvite({ id: 'inv_1' })).toBeNull();
    expect(toMyInvite({ id: 'inv_1', binding: { name: 'no-id' } })).toBeNull();
    expect(toMyInvite(null)).toBeNull();
  });

  it('tolerates a missing inviter and null binding name', () => {
    expect(toMyInvite({ id: 'inv_1', binding: { id: 'b', name: null } })).toEqual({
      id: 'inv_1',
      role: null,
      createdAt: '',
      expiresAt: null,
      binding: { id: 'b', name: null },
      inviter: { name: null, email: null, avatarUrl: null },
    });
  });
});

describe('toEmailOutcome', () => {
  it('passes through the relay verdict', () => {
    expect(toEmailOutcome({ sent: true, to: 'a@b.co' })).toEqual({
      sent: true,
      to: 'a@b.co',
      reason: null,
    });
    expect(toEmailOutcome({ sent: false, to: null, reason: 'no_email' })).toEqual({
      sent: false,
      to: null,
      reason: 'no_email',
    });
  });

  it('coerces a missing field (older relay) to an honest "not sent"', () => {
    expect(toEmailOutcome(undefined)).toEqual({ sent: false, to: null, reason: null });
    expect(toEmailOutcome('junk')).toEqual({ sent: false, to: null, reason: null });
  });
});
