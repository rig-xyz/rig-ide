import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { rigRigs, rigSessions } from '@main/db/schema';

/**
 * Round S2+ (session title editing): `rig_sessions` gains a `title_source`
 * column ('auto' | 'manual') — the auto-titling write path must never
 * overwrite a title the user set by hand (see `main/rig/sessions.ts`'s
 * `setTitle`/`rename`). `rig_sessions` predates this migration (0020), so
 * unlike a brand-new table this DOES have a real pre-existing-data ALTER
 * concern: an existing row must backfill to `'auto'` (the honest default —
 * every session that existed before this shipped got its title, if any, the
 * old auto-derived way), never `NULL` or `'manual'`.
 */
describe('0022_rig_sessions_title_source', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds a NOT NULL title_source column, defaulting to auto', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite
      .prepare(`PRAGMA table_info('rig_sessions')`)
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const column = columns.find((c) => c.name === 'title_source');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("'auto'");
  });

  /**
   * C3 fix: every other test here opens `'empty'` — migrations 0001..0022
   * run in sequence, but starting from literally nothing, so `rig_sessions`
   * (created fresh by migration 0020) never has a pre-existing-data ALTER
   * to actually exercise. `'pre-0019'` is a REAL historical snapshot,
   * committed alongside an earlier migration (see `example.test.ts`'s own
   * pattern) — opening it runs the exact same 0019..0022 migration files
   * against a genuinely-upgraded database instead of a synthetic blank
   * slate, the honest way to catch anything that only shows up on a real
   * upgrade path (e.g. a migration whose behavior implicitly depends on
   * state an `'empty'` fixture never has).
   */
  it('the upgrade path (pre-0019 baseline, not a fresh db) ends up with the same NOT NULL / default-auto shape', async () => {
    fixture = await openFixture('pre-0019');

    const columns = fixture.sqlite
      .prepare(`PRAGMA table_info('rig_sessions')`)
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const column = columns.find((c) => c.name === 'title_source');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("'auto'");

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
    const [row] = await fixture.db.select().from(rigSessions);
    expect(row.titleSource).toBe('auto');
  });

  it('a freshly inserted row defaults to auto without specifying it', async () => {
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

    const [row] = await fixture.db.select().from(rigSessions);
    expect(row.titleSource).toBe('auto');
  });

  it('accepts an explicit manual title_source', async () => {
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
      title: 'My renamed session',
      titleSource: 'manual',
      createdAt: 1,
      updatedAt: 1,
    });

    const [row] = await fixture.db.select().from(rigSessions);
    expect(row.title).toBe('My renamed session');
    expect(row.titleSource).toBe('manual');
  });
});
