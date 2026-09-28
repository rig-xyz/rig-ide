import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { rigCommentsCache, rigRoomCache } from '@main/db/schema';

/**
 * Room disk cache (rig/docs/room-disk-cache-spec.md): a new
 * `rig_room_cache` table keyed by (account, binding), and an `account_id`
 * on `rig_comments_cache` so a cached comment thread is only ever read back
 * by the account that wrote it. Rows cached before accounts were recorded
 * can't be attributed, so the migration drops them (it's a cache: the next
 * read refills it).
 */
describe('0025_rig_room_cache', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates rig_room_cache with an (account_id, binding_id) key', async () => {
    fixture = await openFixture('empty');
    const columns = fixture.sqlite.prepare(`PRAGMA table_info('rig_room_cache')`).all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    expect(columns.map((c) => c.name).sort()).toEqual(
      ['account_id', 'binding_id', 'bytes', 'format_version', 'opened_at', 'relay_host', 'saved_at', 'snapshot_json'].sort()
    );
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['account_id', 'binding_id']);
    expect(columns.every((c) => c.notnull === 1)).toBe(true);
  });

  it('round-trips a row, one per (account, binding)', async () => {
    fixture = await openFixture('empty');
    const row = { relayHost: 'tap-relay.fly.dev', formatVersion: 1, snapshotJson: '{}', bytes: 2, savedAt: 1, openedAt: 1 };
    await fixture.db.insert(rigRoomCache).values({ accountId: 'u1', bindingId: 'b1', ...row });
    await fixture.db.insert(rigRoomCache).values({ accountId: 'u2', bindingId: 'b1', ...row });
    await expect(fixture.db.insert(rigRoomCache).values({ accountId: 'u1', bindingId: 'b1', ...row })).rejects.toThrow();
    expect(await fixture.db.select().from(rigRoomCache)).toHaveLength(2);
  });

  it('adds a nullable account_id to rig_comments_cache', async () => {
    fixture = await openFixture('empty');
    const column = (
      fixture.sqlite.prepare(`PRAGMA table_info('rig_comments_cache')`).all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'account_id');
    expect(column?.notnull).toBe(0);
    await fixture.db
      .insert(rigCommentsCache)
      .values({ bindingId: 'b1', relPath: 'a.md', threadsJson: '[]', syncedAt: 1, accountId: 'u1' });
    const [stored] = await fixture.db.select().from(rigCommentsCache);
    expect(stored?.accountId).toBe('u1');
  });

  it('drops comment threads cached before accounts were recorded', async () => {
    fixture = await openFixture('baseline');
    // The baseline fixture predates this migration; whatever it cached is gone after it.
    expect(fixture.sqlite.prepare('SELECT * FROM rig_comments_cache WHERE account_id IS NULL').all()).toHaveLength(0);
  });
});
