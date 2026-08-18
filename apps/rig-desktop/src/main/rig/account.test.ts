import { describe, expect, it } from 'vitest';
import { resolveRelayUrl, toBinding, toUser } from './account';
import { checkRelayTrust } from './relay-trust';

// The env parameter is passed explicitly (mirrors relay-trust.test.ts) so
// these never depend on the machine's real environment.

describe('resolveRelayUrl', () => {
  it('defaults to the known relay when RIG_RELAY_URL is unset', () => {
    expect(resolveRelayUrl(undefined)).toBe('https://tap-relay.fly.dev');
  });

  it('trims RIG_RELAY_URL when set', () => {
    expect(resolveRelayUrl('  https://tap-relay.fly.dev  ')).toBe('https://tap-relay.fly.dev');
  });

  it('falls back to the default for an empty/whitespace-only value', () => {
    expect(resolveRelayUrl('')).toBe('https://tap-relay.fly.dev');
    expect(resolveRelayUrl('   ')).toBe('https://tap-relay.fly.dev');
  });
});

describe('trust gating of the default relay URL', () => {
  it('the default relay URL is trusted', () => {
    expect(checkRelayTrust(resolveRelayUrl(undefined)).trusted).toBe(true);
  });

  it('a hostile RIG_RELAY_URL is refused rather than trusted by default', () => {
    const hostile = resolveRelayUrl('https://attacker.example');
    expect(checkRelayTrust(hostile)).toEqual({ trusted: false, host: 'attacker.example' });
  });

  it('a hostile plain-http RIG_RELAY_URL is refused too', () => {
    const hostile = resolveRelayUrl('http://tap-relay.fly.dev');
    expect(checkRelayTrust(hostile).trusted).toBe(false);
  });
});

describe('toUser', () => {
  it('parses a full /v1/me user payload', () => {
    expect(
      toUser({
        id: 'usr_1',
        clerkUserId: 'clerk_1',
        email: 'a@example.com',
        name: 'Ada',
        avatarUrl: 'https://example.com/a.png',
        createdAt: '2026-01-01T00:00:00Z',
      })
    ).toEqual({
      id: 'usr_1',
      clerkUserId: 'clerk_1',
      email: 'a@example.com',
      name: 'Ada',
      avatarUrl: 'https://example.com/a.png',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('degrades a missing name/avatarUrl to null rather than dropping the user', () => {
    expect(
      toUser({
        id: 'usr_1',
        clerkUserId: 'clerk_1',
        email: 'a@example.com',
        createdAt: '2026-01-01T00:00:00Z',
      })
    ).toEqual({
      id: 'usr_1',
      clerkUserId: 'clerk_1',
      email: 'a@example.com',
      name: null,
      avatarUrl: null,
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  // The relay really does return `email: null` (accounts created through Clerk
  // need not carry one). Mapping that to '' made the chip pick '' as its label
  // via `??`, which renders as a blank chip.
  it('degrades a null or empty email to null, never to an empty string', () => {
    expect(toUser({ id: 'usr_1', clerkUserId: 'clerk_1', email: null })?.email).toBeNull();
    expect(toUser({ id: 'usr_1', clerkUserId: 'clerk_1', email: '' })?.email).toBeNull();
    expect(toUser({ id: 'usr_1', clerkUserId: 'clerk_1' })?.email).toBeNull();
  });

  it('returns null for a shape that is not a user at all', () => {
    expect(toUser(null)).toBeNull();
    expect(toUser({})).toBeNull();
    expect(toUser('nope')).toBeNull();
  });
});

describe('toBinding', () => {
  it('parses a binding row and fills in the relay host', () => {
    expect(
      toBinding(
        {
          binding: { id: 'bnd_1', name: 'my-rig', createdAt: '2026-05-12T00:00:00Z' },
          role: 'owner',
          lastSyncedAt: '2026-01-01T00:00:00Z',
        },
        'tap-relay.fly.dev'
      )
    ).toEqual({
      id: 'bnd_1',
      name: 'my-rig',
      role: 'owner',
      lastSyncedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-05-12T00:00:00Z',
      relayHost: 'tap-relay.fly.dev',
    });
  });

  it('degrades a null lastSyncedAt (never synced from this account)', () => {
    expect(
      toBinding(
        { binding: { id: 'bnd_1', name: 'my-rig' }, role: 'editor', lastSyncedAt: null },
        'h'
      )?.lastSyncedAt
    ).toBeNull();
  });

  it('degrades a missing createdAt to an empty string rather than dropping the binding', () => {
    expect(
      toBinding({ binding: { id: 'bnd_1', name: 'my-rig' }, role: 'editor', lastSyncedAt: null }, 'h')
        ?.createdAt
    ).toBe('');
  });

  it('returns null for a row with no binding', () => {
    expect(toBinding({ role: 'owner' }, 'h')).toBeNull();
    expect(toBinding(null, 'h')).toBeNull();
  });
});
