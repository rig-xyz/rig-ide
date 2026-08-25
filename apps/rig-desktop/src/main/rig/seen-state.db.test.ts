import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { rigRigs, rigSeenFiles } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn<(channel: unknown, payload: unknown) => void>(),
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({
  events: { emit: (...args: [unknown, unknown]) => mocks.emit(...args) },
}));

const { rigSeenStateController } = await import('./seen-state');

let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.emit.mockReset();
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
});

async function seedRig(bindingId: string, firstOpenedAt: number) {
  await fixture.db.insert(rigRigs).values({
    id: `row-${bindingId}`,
    path: `/tmp/${bindingId}`,
    bindingId,
    firstOpenedAt,
    lastOpenedAt: firstOpenedAt,
  });
}

describe('rigSeenStateController.getState', () => {
  it('baseline comes from rig_rigs.first_opened_at, and seen starts empty', async () => {
    await seedRig('bnd_a', 1000);
    const result = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(result).toEqual({ baselineAt: 1000, seen: {} });
  });

  it('falls back to a "now" baseline (never crashes) when the rig row is unknown', async () => {
    const before = Date.now();
    const result = await rigSeenStateController.getState({ bindingId: 'bnd_unknown' });
    expect(result.baselineAt).toBeGreaterThanOrEqual(before);
    expect(result.seen).toEqual({});
  });

  it('reflects every marked-seen path for that bindingId, and none for another', async () => {
    await seedRig('bnd_a', 1000);
    await seedRig('bnd_b', 1000);
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'notes.md' });
    await rigSeenStateController.markSeen({ bindingId: 'bnd_b', relPath: 'other.md' });

    const result = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(Object.keys(result.seen)).toEqual(['notes.md']);
  });
});

describe('rigSeenStateController.markSeen', () => {
  it('sets a fresh lastViewedAt for a never-before-seen path', async () => {
    await seedRig('bnd_a', 1000);
    const before = Date.now();
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'a.md' });
    const { seen } = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(seen['a.md']).toBeGreaterThanOrEqual(before);
  });

  it('re-viewing the same path updates lastViewedAt rather than inserting a duplicate row', async () => {
    await seedRig('bnd_a', 1000);
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'a.md' });
    const first = (await rigSeenStateController.getState({ bindingId: 'bnd_a' })).seen['a.md'];

    await new Promise((resolve) => setTimeout(resolve, 5));
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'a.md' });
    const rows = await fixture.db.select().from(rigSeenFiles);
    expect(rows.filter((r) => r.bindingId === 'bnd_a' && r.relPath === 'a.md')).toHaveLength(1);
    const second = (await rigSeenStateController.getState({ bindingId: 'bnd_a' })).seen['a.md'];
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('broadcasts rig:seen-state-changed for the affected bindingId', async () => {
    await seedRig('bnd_a', 1000);
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'a.md' });
    expect(mocks.emit).toHaveBeenCalledWith(expect.anything(), { bindingId: 'bnd_a' });
  });
});

describe('rigSeenStateController.markAllSeen', () => {
  it('marks every given relPath seen in one call', async () => {
    await seedRig('bnd_a', 1000);
    await rigSeenStateController.markAllSeen({ bindingId: 'bnd_a', relPaths: ['a.md', 'b.md', 'sub/c.md'] });
    const { seen } = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(Object.keys(seen).sort()).toEqual(['a.md', 'b.md', 'sub/c.md']);
  });

  it('an empty relPaths list is a no-op — no rows written, no broadcast', async () => {
    await seedRig('bnd_a', 1000);
    await rigSeenStateController.markAllSeen({ bindingId: 'bnd_a', relPaths: [] });
    const { seen } = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(seen).toEqual({});
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('rigSeenStateController.sweep', () => {
  it('deletes a seen entry whose path no longer exists in the current listing', async () => {
    await seedRig('bnd_a', 1000);
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'deleted.md' });
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'still-here.md' });

    await rigSeenStateController.sweep({ bindingId: 'bnd_a', existingRelPaths: ['still-here.md'] });

    const { seen } = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(Object.keys(seen)).toEqual(['still-here.md']);
  });

  it('an empty existingRelPaths list deletes every seen entry for that rig — nothing exists any more', async () => {
    await seedRig('bnd_a', 1000);
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'gone.md' });
    await rigSeenStateController.sweep({ bindingId: 'bnd_a', existingRelPaths: [] });
    const { seen } = await rigSeenStateController.getState({ bindingId: 'bnd_a' });
    expect(seen).toEqual({});
  });

  it('never touches another rig’s seen entries', async () => {
    await seedRig('bnd_a', 1000);
    await seedRig('bnd_b', 1000);
    await rigSeenStateController.markSeen({ bindingId: 'bnd_a', relPath: 'a.md' });
    await rigSeenStateController.markSeen({ bindingId: 'bnd_b', relPath: 'b.md' });

    await rigSeenStateController.sweep({ bindingId: 'bnd_a', existingRelPaths: [] });

    const bResult = await rigSeenStateController.getState({ bindingId: 'bnd_b' });
    expect(Object.keys(bResult.seen)).toEqual(['b.md']);
  });
});
