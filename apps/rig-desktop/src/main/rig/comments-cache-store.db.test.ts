import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { RigCommentMessage, RigCommentTarget } from '@shared/rig/comments';

// Same pattern as recent-rigs.db.test.ts: stop client.ts from opening the
// real Electron DB at import time.
const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  target: null as RigCommentTarget | null,
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
// `resolveCommentTarget`'s own path-resolution logic is covered directly by
// comments.test.ts; here it's stubbed so cacheGet/cacheSet can be exercised
// against a fixed (bindingId, relPath) without a real bound-rig fixture.
vi.mock('./comments', () => ({
  resolveCommentTarget: () => mocks.target,
}));

const { rigCommentsCacheController } = await import('./comments-cache-store');

let fixture: Awaited<ReturnType<typeof openFixture>>;

function message(id: string): RigCommentMessage {
  return {
    id,
    seq: '1',
    bindingId: 'binding-1',
    author: { userId: 'u1', name: 'Dylan', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: 'hello',
    parentId: null,
    intentId: null,
    path: 'docs/spec.md',
    meta: null,
    anchor: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-08-14T20:04:00.000Z',
    editedAt: null,
    deletedAt: null,
  };
}

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.target = { bindingId: 'binding-1', relayUrl: 'https://tap-relay.fly.dev', relPath: 'docs/spec.md' };
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
  mocks.target = null;
});

describe('cacheGet', () => {
  it('returns null when nothing has ever been cached', async () => {
    await expect(rigCommentsCacheController.cacheGet({ absPath: '/tmp/rig/docs/spec.md' })).resolves.toBeNull();
  });

  it('returns null when the file is not bound', async () => {
    mocks.target = null;
    await expect(rigCommentsCacheController.cacheGet({ absPath: '/tmp/unbound.md' })).resolves.toBeNull();
  });

  it('round-trips a cacheSet through cacheGet', async () => {
    const messages = [message('m1'), message('m2')];
    await rigCommentsCacheController.cacheSet({
      absPath: '/tmp/rig/docs/spec.md',
      messages,
      lastSyncedAt: '2026-08-14T20:04:00.000Z',
    });

    const entry = await rigCommentsCacheController.cacheGet({ absPath: '/tmp/rig/docs/spec.md' });
    expect(entry).toEqual({
      bindingId: 'binding-1',
      relPath: 'docs/spec.md',
      lastSyncedAt: '2026-08-14T20:04:00.000Z',
      messages,
    });
  });
});

describe('cacheSet', () => {
  it('is a no-op when the file is not bound', async () => {
    mocks.target = null;
    await rigCommentsCacheController.cacheSet({
      absPath: '/tmp/unbound.md',
      messages: [message('m1')],
      lastSyncedAt: '2026-08-14T20:04:00.000Z',
    });
    const rows = fixture.sqlite.prepare('SELECT * FROM rig_comments_cache').all();
    expect(rows).toHaveLength(0);
  });

  it('overwrites the previous snapshot on a second write, keyed on (binding, path)', async () => {
    await rigCommentsCacheController.cacheSet({
      absPath: '/tmp/rig/docs/spec.md',
      messages: [message('m1')],
      lastSyncedAt: '2026-08-14T20:04:00.000Z',
    });
    await rigCommentsCacheController.cacheSet({
      absPath: '/tmp/rig/docs/spec.md',
      messages: [message('m1'), message('m2')],
      lastSyncedAt: '2026-08-14T20:05:00.000Z',
    });

    const rows = fixture.sqlite.prepare('SELECT * FROM rig_comments_cache').all();
    expect(rows).toHaveLength(1);
    const entry = await rigCommentsCacheController.cacheGet({ absPath: '/tmp/rig/docs/spec.md' });
    expect(entry?.messages).toHaveLength(2);
    expect(entry?.lastSyncedAt).toBe('2026-08-14T20:05:00.000Z');
  });

  it('falls back to the current time for an unparseable lastSyncedAt', async () => {
    const before = Date.now();
    await rigCommentsCacheController.cacheSet({
      absPath: '/tmp/rig/docs/spec.md',
      messages: [message('m1')],
      lastSyncedAt: 'not-a-date',
    });
    const row = fixture.sqlite.prepare('SELECT synced_at FROM rig_comments_cache').get() as {
      synced_at: number;
    };
    expect(row.synced_at).toBeGreaterThanOrEqual(before);
  });
});
