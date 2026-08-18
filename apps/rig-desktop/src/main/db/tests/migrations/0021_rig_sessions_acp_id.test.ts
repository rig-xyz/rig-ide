import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { rigRigs, rigSessions } from '@main/db/schema';

/**
 * Round B of persistence-design.md: `rig_sessions` gains a nullable
 * `acp_session_id` column (the underlying ACP agent's own session id, for a
 * genuine `loadSession` resume — distinct from `id`, this app's own
 * conversationId). `rig_sessions` itself is new-this-round (0020), so there
 * is no pre-existing-data ALTER concern to fixture against — `empty` proves
 * the column exists and is nullable on a fresh database.
 */
describe('0021_rig_sessions_acp_id', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds a nullable acp_session_id column to rig_sessions', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite
      .prepare(`PRAGMA table_info('rig_sessions')`)
      .all() as { name: string; notnull: number }[];
    const column = columns.find((c) => c.name === 'acp_session_id');
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  it('accepts a row with no acp_session_id and one with one set', async () => {
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
    await fixture.db.insert(rigSessions).values({
      id: 's2',
      rigId: 'r1',
      providerId: 'codex',
      createdAt: 1,
      updatedAt: 1,
      acpSessionId: 'acp-session-abc',
    });

    const rows = await fixture.db.select().from(rigSessions);
    expect(rows.find((r) => r.id === 's1')?.acpSessionId).toBeNull();
    expect(rows.find((r) => r.id === 's2')?.acpSessionId).toBe('acp-session-abc');
  });
});
