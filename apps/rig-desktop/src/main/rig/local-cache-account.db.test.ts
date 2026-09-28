import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

/**
 * Whose the local caches are: known from `/v1/me` for the current token
 * (never asked for here), remembered for that same token offline, and
 * everything of another account purged when it changes or on sign-out.
 */

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  ctx: { url: 'https://tap-relay.fly.dev', token: 'token-a' } as { url: string; token: string } | null,
  self: 'u1' as string | null,
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('./account', () => ({
  resolveContext: async () => mocks.ctx ?? { kind: 'notSignedIn', message: 'Not signed in.' },
  isError: (value: object) => 'kind' in value,
  peekSelfUserId: async () => (mocks.ctx ? mocks.self : null),
}));

const { forgetLocalCaches, localCacheAccountId, purgeLocalCaches, readRememberedWorkspaces, rememberWorkspaces } =
  await import('./local-cache-account');
const { offlineHomeSnapshot } = await import('./offline-home');

function binding(id: string, kind: 'rig' | 'space' = 'space') {
  return { id, name: `name-${id}`, role: 'owner', kind, lastSyncedAt: null, createdAt: '', relayHost: 'tap-relay.fly.dev' };
}

let fixture: Awaited<ReturnType<typeof openFixture>>;

function seed(): void {
  const room = fixture.sqlite.prepare("INSERT INTO rig_room_cache VALUES (?, ?, 'tap-relay.fly.dev', 1, '{}', 2, 1, 1)");
  room.run('u1', 'b1');
  room.run('u2', 'b1');
  const comments = fixture.sqlite.prepare(
    "INSERT INTO rig_comments_cache (binding_id, rel_path, threads_json, synced_at, account_id) VALUES (?, ?, '[]', 1, ?)"
  );
  comments.run('b1', 'mine.md', 'u1');
  comments.run('b1', 'theirs.md', 'u2');
  comments.run('b1', 'legacy.md', null);
}

const owners = (table: string) =>
  (fixture.sqlite.prepare(`SELECT account_id FROM ${table} ORDER BY account_id`).all() as Array<{ account_id: string | null }>).map(
    (r) => r.account_id
  );

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.ctx = { url: 'https://tap-relay.fly.dev', token: 'token-a' };
  mocks.self = 'u1';
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
});

describe('localCacheAccountId', () => {
  it('is the signed-in user once known, and stays known offline for the same token', async () => {
    await expect(localCacheAccountId()).resolves.toBe('u1');
    mocks.self = null; // relaunched offline: `/v1/me` hasn't answered
    await expect(localCacheAccountId()).resolves.toBe('u1');
  });

  it('is unknown for another token until `/v1/me` says whose it is, and null signed out', async () => {
    await localCacheAccountId();
    mocks.self = null;
    mocks.ctx = { url: 'https://tap-relay.fly.dev', token: 'token-b' };
    await expect(localCacheAccountId()).resolves.toBeNull();
    mocks.ctx = null;
    await expect(localCacheAccountId()).resolves.toBeNull();
  });

  it('never keeps the token itself', async () => {
    await localCacheAccountId();
    const stored = JSON.stringify(fixture.sqlite.prepare('SELECT * FROM kv').all());
    expect(stored).not.toContain('token-a');
  });

  it('another account signing in purges everything of the previous one (and unowned rows)', async () => {
    await localCacheAccountId(); // u1 remembered
    seed();
    mocks.self = 'u2';
    mocks.ctx = { url: 'https://tap-relay.fly.dev', token: 'token-b' };
    await expect(localCacheAccountId()).resolves.toBe('u2');
    expect(owners('rig_room_cache')).toEqual(['u2']);
    expect(owners('rig_comments_cache')).toEqual(['u2']);
  });
});

describe('purgeLocalCaches', () => {
  it('on sign-out, every account’s rows go, and whose they were is forgotten', async () => {
    await localCacheAccountId();
    seed();
    await purgeLocalCaches();
    expect(owners('rig_room_cache')).toEqual([]);
    expect(owners('rig_comments_cache')).toEqual([]);
    mocks.self = null;
    await expect(localCacheAccountId()).resolves.toBeNull(); // no offline fallback left either
  });
});

describe('remembered workspaces (Home offline)', () => {
  it('serves the account its own last list offline, and nothing for another token', async () => {
    await rememberWorkspaces([binding('s1'), binding('r1', 'rig')]);
    mocks.self = null; // relaunched offline
    const mine = await readRememberedWorkspaces();
    expect(mine.accountId).toBe('u1');
    expect(mine.workspaces?.bindings.map((b) => b.id)).toEqual(['s1', 'r1']);
    mocks.ctx = { url: 'https://tap-relay.fly.dev', token: 'token-b' };
    await expect(readRememberedWorkspaces()).resolves.toEqual({ accountId: null, workspaces: null });
  });

  it('is not served on another relay', async () => {
    await rememberWorkspaces([binding('s1')]);
    await localCacheAccountId();
    mocks.ctx = { url: 'https://other-relay.example', token: 'token-a' };
    mocks.self = 'u1';
    expect((await readRememberedWorkspaces()).workspaces).toBeNull();
  });

  it('is never stored without a known account', async () => {
    mocks.self = null;
    await rememberWorkspaces([binding('s1')]);
    mocks.self = 'u1';
    expect((await readRememberedWorkspaces()).workspaces).toBeNull();
  });

  it('goes on sign-out and on an account switch; a forgotten space drops out of it', async () => {
    await rememberWorkspaces([binding('s1'), binding('s2')]);
    await forgetLocalCaches('s1');
    expect((await readRememberedWorkspaces()).workspaces?.bindings.map((b) => b.id)).toEqual(['s2']);
    mocks.self = 'u2';
    mocks.ctx = { url: 'https://tap-relay.fly.dev', token: 'token-b' };
    expect((await readRememberedWorkspaces()).workspaces).toBeNull();
    await rememberWorkspaces([binding('s3')]);
    await purgeLocalCaches();
    expect((await readRememberedWorkspaces()).workspaces).toBeNull();
  });

  it('the Home snapshot carries only this account’s saved-chat times', async () => {
    await rememberWorkspaces([binding('b1')]);
    seed();
    const snapshot = await offlineHomeSnapshot();
    expect(snapshot.accountId).toBe('u1');
    expect(snapshot.roomSavedAt).toEqual({ b1: 1 });
    expect(snapshot.workspaces?.bindings.map((b) => b.id)).toEqual(['b1']);
  });
});
