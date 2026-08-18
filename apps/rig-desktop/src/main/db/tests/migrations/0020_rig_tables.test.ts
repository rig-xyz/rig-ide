import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  rigCommentsCache,
  rigProfiles,
  rigRigs,
  rigSessionEvents,
  rigSessions,
} from '@main/db/schema';

/**
 * Round A of persistence-design.md: five new tables, no pre-existing data to
 * migrate (they're pure additions), so `openFixture('empty')` — a fresh
 * database with every migration applied via the app's own
 * `initializeDatabase()` — is the right fixture: it's the "clean on a fresh
 * userData dir" proof the round asked for, not just a unit test.
 */
describe('0020_rig_tables', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates all five rig_* tables on a fresh database', async () => {
    fixture = await openFixture('empty');

    const tables = fixture.sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rig_%' ORDER BY name`
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      'rig_comments_cache',
      'rig_profiles',
      'rig_rigs',
      'rig_session_events',
      'rig_sessions',
    ]);
  });

  it('enforces one rig_rigs row per binding id', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'binding-1',
      name: 'my-rig',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
      openCount: 1,
    });
    await expect(
      fixture.db.insert(rigRigs).values({
        id: 'r2',
        path: '/tmp/rig-elsewhere',
        bindingId: 'binding-1',
        firstOpenedAt: 2,
        lastOpenedAt: 2,
        openCount: 1,
      })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('cascades rig_sessions and rig_session_events when the rig is deleted', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'binding-1',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });
    await fixture.db.insert(rigSessions).values({
      id: 's1',
      rigId: 'r1',
      providerId: 'claude',
      createdAt: 1,
      updatedAt: 1,
    });
    await fixture.db.insert(rigSessionEvents).values({
      sessionId: 's1',
      seq: 0,
      at: 1,
      eventJson: '{}',
    });

    await fixture.db.delete(rigRigs);

    const remainingSessions = await fixture.db.select().from(rigSessions);
    const remainingEvents = await fixture.db.select().from(rigSessionEvents);
    expect(remainingSessions).toHaveLength(0);
    expect(remainingEvents).toHaveLength(0);
  });

  it('enforces one rig_session_events row per (session, seq)', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'binding-1',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });
    await fixture.db.insert(rigSessions).values({
      id: 's1',
      rigId: 'r1',
      providerId: 'claude',
      createdAt: 1,
      updatedAt: 1,
    });
    await fixture.db.insert(rigSessionEvents).values({ sessionId: 's1', seq: 0, at: 1, eventJson: '{}' });
    await expect(
      fixture.db.insert(rigSessionEvents).values({ sessionId: 's1', seq: 0, at: 2, eventJson: '{}' })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('keys rig_comments_cache on (binding_id, rel_path)', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigCommentsCache).values({
      bindingId: 'binding-1',
      relPath: 'docs/spec.md',
      threadsJson: '[]',
      syncedAt: 1,
    });
    await expect(
      fixture.db.insert(rigCommentsCache).values({
        bindingId: 'binding-1',
        relPath: 'docs/spec.md',
        threadsJson: '[]',
        syncedAt: 2,
      })
    ).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it('rig_profiles keys on user id', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigProfiles).values({
      userId: 'u1',
      name: 'Dylan',
      avatarUrl: null,
      email: 'dylan@example.com',
      fetchedAt: 1,
    });
    const rows = await fixture.db.select().from(rigProfiles);
    expect(rows).toHaveLength(1);
  });
});
