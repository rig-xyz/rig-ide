import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { rigRigs } from '@main/db/schema';

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs"):
 * `rig_rigs` gains a nullable `account_id` column — the stable id of
 * whoever bound or last opened the rig through this app, stamped by
 * `recent-rigs.ts`'s `recordRigOpened`. `rig_rigs` predates this migration
 * (0020), but unlike `0022_rig_sessions_title_source`'s NOT-NULL-with-
 * default column, this one is plain nullable with no default at all — a
 * pre-existing row simply has no account recorded yet (the spec's own
 * "legacy row, shown to everyone until an open while signed in backfills
 * it"), so there is no default-value backfill behavior to verify, only
 * that the column exists, is nullable, and round-trips a value.
 */
describe('0024_rig_rigs_account_id', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds a nullable account_id column to rig_rigs', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite
      .prepare(`PRAGMA table_info('rig_rigs')`)
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const column = columns.find((c) => c.name === 'account_id');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
  });

  it('a row inserted without account_id (the pre-existing/legacy shape) is null, not an error', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'binding-1',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const [row] = await fixture.db.select().from(rigRigs);
    expect(row.accountId).toBeNull();
  });

  it('accepts and round-trips an explicit account_id', async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'binding-1',
      accountId: 'usr_abc123',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const [row] = await fixture.db.select().from(rigRigs);
    expect(row.accountId).toBe('usr_abc123');
  });
});
