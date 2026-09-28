import { describe, expect, it } from 'vitest';
import {
  deriveHomeConnection,
  needsConnection,
  offlineLastActivity,
  reconnectDelayMs,
  resolveHomeAccountId,
  withRememberedWorkspaces,
} from './home-connection';
import type { HomeWorkspacesState } from './home-sections';

const ok: HomeWorkspacesState = { status: 'ok', bindings: [] };
const base = { signedIn: true, navigatorOnline: true, workspaces: ok, waitedLong: false };

describe('deriveHomeConnection', () => {
  it('is online when the list came back', () => {
    expect(deriveHomeConnection(base)).toBe('online');
  });

  it('is offline with no network, whatever the queries last said', () => {
    expect(deriveHomeConnection({ ...base, navigatorOnline: false })).toBe('offline');
    expect(deriveHomeConnection({ ...base, navigatorOnline: false, workspaces: { status: 'loading' } })).toBe('offline');
  });

  it('is unreachable when online but the relay failed', () => {
    expect(deriveHomeConnection({ ...base, workspaces: { status: 'unreachable' } })).toBe('unreachable');
  });

  it('slow is not offline: a long first load is only a hint', () => {
    expect(deriveHomeConnection({ ...base, workspaces: { status: 'loading' } })).toBe('online');
    const slow = deriveHomeConnection({ ...base, workspaces: { status: 'loading' }, waitedLong: true });
    expect(slow).toBe('slow');
    expect(needsConnection(slow)).toBe(false);
  });

  it('says nothing signed out', () => {
    expect(deriveHomeConnection({ ...base, signedIn: false, navigatorOnline: false })).toBe('online');
  });

  it('only offline and unreachable disable relay actions', () => {
    expect(needsConnection('offline')).toBe(true);
    expect(needsConnection('unreachable')).toBe(true);
    expect(needsConnection('online')).toBe(false);
  });
});

describe('reconnectDelayMs', () => {
  it('backs off and caps at a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
});

describe('withRememberedWorkspaces', () => {
  const remembered = [
    { id: 's1', name: 'design', kind: 'space' as const, role: 'owner', lastSyncedAt: null, createdAt: '', relayHost: 'h' },
  ];

  it('falls back to the remembered list while loading or unreachable', () => {
    for (const status of ['loading', 'unreachable'] as const) {
      const rows = withRememberedWorkspaces({ status }, remembered);
      expect(rows.status === 'ok' && rows.bindings.map((b) => [b.bindingId, b.kind])).toEqual([['s1', 'space']]);
    }
  });

  it('never replaces a live list, never applies signed out, and is a no-op without one', () => {
    expect(withRememberedWorkspaces(ok, remembered)).toBe(ok);
    expect(withRememberedWorkspaces({ status: 'skipped' }, remembered)).toEqual({ status: 'skipped' });
    expect(withRememberedWorkspaces({ status: 'unreachable' }, null)).toEqual({ status: 'unreachable' });
  });
});

describe('resolveHomeAccountId', () => {
  const input = { signedIn: true, meId: undefined, meFailed: false, rememberedAccountId: undefined };

  it('prefers the live answer, then the remembered one', () => {
    expect(resolveHomeAccountId({ ...input, meId: 'u1', rememberedAccountId: 'u2' })).toBe('u1');
    expect(resolveHomeAccountId({ ...input, meFailed: true, rememberedAccountId: 'u1' })).toBe('u1');
    expect(resolveHomeAccountId({ ...input, rememberedAccountId: 'u1' })).toBe('u1');
  });

  it('offline with no known account shows no account’s rows (null), never everyone’s', () => {
    expect(resolveHomeAccountId({ ...input, meFailed: true, rememberedAccountId: null })).toBeNull();
  });

  it('holds off (undefined) only while nothing has answered yet; null signed out', () => {
    expect(resolveHomeAccountId(input)).toBeUndefined();
    expect(resolveHomeAccountId({ ...input, signedIn: false, meId: 'u1' })).toBeNull();
  });
});

describe('offlineLastActivity', () => {
  it('is the latest local signal, or null when there is none', () => {
    expect(offlineLastActivity({ lastOpenedAt: 10, sessions: [{ updatedAt: 30 }] }, 20)).toBe(30);
    expect(offlineLastActivity({ lastOpenedAt: 10, sessions: [] }, 50)).toBe(50);
    expect(offlineLastActivity({ sessions: [] }, undefined)).toBeNull();
  });
});
