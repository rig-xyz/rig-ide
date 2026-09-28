import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { ROOM_CACHE_FORMAT_VERSION, ROOM_CACHE_MAX_SPACES, type CachedRoomBlob } from '@shared/spaces/room-cache';

/**
 * `rig_room_cache` (rig/docs/room-disk-cache-spec.md): one Room per
 * (account, space), gated to the signed-in account and the current relay,
 * capped, and forgotten with the space or the account.
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
  resolveRelayUrl: () => mocks.ctx?.url ?? 'https://tap-relay.fly.dev',
}));

const { rigRoomCacheController: cache } = await import('./room-cache-store');

let fixture: Awaited<ReturnType<typeof openFixture>>;

function blob(overrides: Partial<CachedRoomBlob> = {}): CachedRoomBlob {
  return {
    v: ROOM_CACHE_FORMAT_VERSION,
    relayHost: 'whatever-the-renderer-said',
    savedAt: 1_000,
    lastMessageSeq: 2,
    messages: [
      { id: 'm1', seq: 1, authorId: 'u1', createdAt: '2026-09-28T09:00:00Z', time: '09:00', body: 'hi', meta: { kind: 'text' } },
      { id: 'm2', seq: 2, authorId: 'u1', createdAt: '2026-09-28T09:01:00Z', time: '09:01', meta: { kind: 'session', runId: 'r1' } },
    ],
    members: [{ id: 'u1', name: 'Alice' }],
    invitesById: {},
    connectors: [],
    skills: [],
    runs: {
      r1: {
        meta: { id: 'r1', agent: 'claude', owner: 'u1', model: 'opus', title: 't', status: 'done', startedAt: '', endedAt: null },
        summary: {
          answer: 'Done.',
          status: 'done',
          model: 'opus',
          stepCount: 3,
          failureReason: null,
          privacy: null,
          detailsHidden: false,
          lastSeq: 9,
        },
      },
    },
    ...overrides,
  };
}

const rows = () =>
  fixture.sqlite.prepare('SELECT account_id, binding_id, relay_host, bytes FROM rig_room_cache ORDER BY binding_id').all() as Array<{
    account_id: string;
    binding_id: string;
    relay_host: string;
    bytes: number;
  }>;

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

describe('get / put', () => {
  it('round-trips a Room for the signed-in account, stamped with the current relay', async () => {
    await expect(cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: blob() })).resolves.toMatchObject({ saved: true });
    const got = await cache.get({ bindingId: 'b1' });
    expect(got?.relayHost).toBe('tap-relay.fly.dev');
    expect(got?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(got?.messages[0]).toMatchObject({ body: 'hi', time: '09:00' }); // the Room's own fields ride along
    expect(rows()).toMatchObject([{ account_id: 'u1', binding_id: 'b1', relay_host: 'tap-relay.fly.dev' }]);
  });

  it('never serves or accepts another account', async () => {
    await cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: blob() });
    await expect(cache.put({ bindingId: 'b2', selfUserId: 'someone-else', blob: blob() })).resolves.toMatchObject({ saved: false });
    mocks.self = 'u2';
    mocks.ctx = { url: 'https://tap-relay.fly.dev', token: 'token-b' };
    await expect(cache.get({ bindingId: 'b1' })).resolves.toBeNull();
  });

  it('signed out, or not knowing who you are yet: nothing is read or written', async () => {
    mocks.ctx = null;
    await expect(cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: blob() })).resolves.toMatchObject({ saved: false });
    await expect(cache.get({ bindingId: 'b1' })).resolves.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("keeps a finished run's hide-safe summary only: steps, thinking and tool output are stripped before writing", async () => {
    const leaky = blob();
    (leaky.runs.r1!.summary as Record<string, unknown>).steps = [{ title: 'cat secrets.md', rawOutput: 'the secret' }];
    (leaky.runs.r1!.summary as Record<string, unknown>).thinking = 'private musing';
    (leaky.runs.r1 as Record<string, unknown>).events = [{ seq: 1, kind: 'tool_call', payload: { rawOutput: 'the secret' } }];
    await cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: leaky });
    const stored = (fixture.sqlite.prepare('SELECT snapshot_json FROM rig_room_cache').get() as { snapshot_json: string }).snapshot_json;
    expect(stored).not.toContain('the secret');
    expect(stored).not.toContain('private musing');
    expect(stored).not.toContain('cat secrets.md');
    expect((await cache.get({ bindingId: 'b1' }))?.runs.r1?.summary?.answer).toBe('Done.');
  });

  it('refuses a blob over the per-space cap', async () => {
    const huge = blob({ messages: [{ id: 'm1', seq: 1, authorId: 'u1', createdAt: '', body: 'x'.repeat(600 * 1024), meta: { kind: 'text' } }] });
    await expect(cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: huge })).resolves.toMatchObject({ saved: false });
    expect(rows()).toHaveLength(0);
  });

  it('refuses a blob that is not this format', async () => {
    await expect(cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: { ...blob(), v: 99 } })).resolves.toMatchObject({ saved: false });
  });
});

describe('discarded on read', () => {
  beforeEach(async () => {
    await cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: blob() });
  });

  it('another format version', async () => {
    fixture.sqlite.prepare('UPDATE rig_room_cache SET format_version = 0').run();
    await expect(cache.get({ bindingId: 'b1' })).resolves.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('another relay', async () => {
    mocks.ctx = { url: 'https://other-relay.example', token: 'token-a' };
    await expect(cache.get({ bindingId: 'b1' })).resolves.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('a corrupt blob', async () => {
    fixture.sqlite.prepare("UPDATE rig_room_cache SET snapshot_json = '{not json'").run();
    await expect(cache.get({ bindingId: 'b1' })).resolves.toBeNull();
    expect(rows()).toHaveLength(0);
  });
});

describe('capacity', () => {
  it(`keeps ${ROOM_CACHE_MAX_SPACES} spaces, dropping the least recently opened`, async () => {
    for (let i = 0; i < ROOM_CACHE_MAX_SPACES; i += 1) {
      await cache.put({ bindingId: `b${String(i).padStart(2, '0')}`, selfUserId: 'u1', blob: blob() });
      fixture.sqlite.prepare('UPDATE rig_room_cache SET opened_at = ? WHERE binding_id = ?').run(i, `b${String(i).padStart(2, '0')}`);
    }
    await cache.get({ bindingId: 'b00' }); // opened again: now the most recent
    await cache.put({ bindingId: 'new', selfUserId: 'u1', blob: blob() });
    const ids = rows().map((r) => r.binding_id);
    expect(ids).toHaveLength(ROOM_CACHE_MAX_SPACES);
    expect(ids).toContain('b00');
    expect(ids).toContain('new');
    expect(ids).not.toContain('b01'); // the oldest one left
  });
});

describe('forget / clear', () => {
  it("forget drops a space's Room and comment threads, for every account", async () => {
    await cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: blob() });
    await cache.put({ bindingId: 'b2', selfUserId: 'u1', blob: blob() });
    fixture.sqlite
      .prepare("INSERT INTO rig_room_cache VALUES ('u9', 'b1', 'tap-relay.fly.dev', 1, '{}', 2, 1, 1)")
      .run();
    fixture.sqlite
      .prepare("INSERT INTO rig_comments_cache (binding_id, rel_path, threads_json, synced_at, account_id) VALUES ('b1', 'a.md', '[]', 1, 'u1')")
      .run();
    await cache.forget({ bindingId: 'b1' });
    expect(rows().map((r) => r.binding_id)).toEqual(['b2']);
    expect(fixture.sqlite.prepare('SELECT * FROM rig_comments_cache').all()).toHaveLength(0);
  });

  it('clear drops everything', async () => {
    await cache.put({ bindingId: 'b1', selfUserId: 'u1', blob: blob() });
    await cache.clear();
    expect(rows()).toHaveLength(0);
  });
});
