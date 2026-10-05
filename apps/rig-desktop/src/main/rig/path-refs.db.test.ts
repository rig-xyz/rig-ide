import { mkdtempSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { rigRigs, rigSeenFiles } from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, emit: vi.fn() }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

const { createEntryMoveFollower, movedPath } = await import('./path-refs');
const { RigSettingsStore } = await import('./settings');

let fixture: Awaited<ReturnType<typeof openFixture>>;
let dir: string;
let rigRoot: string;
let settings: InstanceType<typeof RigSettingsStore>;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.emit.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'rig-path-refs-'));
  rigRoot = realpathSync(dir);
  settings = new RigSettingsStore(join(dir, 'settings.json'));
  settings.initialize();
  const now = Date.now();
  await fixture.db.insert(rigRigs).values([
    { id: 'r1', path: dir, bindingId: 'b1', firstOpenedAt: now, lastOpenedAt: now },
    {
      id: 'r2',
      path: join(dir, 'elsewhere'),
      bindingId: 'b2',
      firstOpenedAt: now,
      lastOpenedAt: now,
    },
  ]);
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('movedPath', () => {
  it('moves the entry and anything inside it, never a sibling sharing the prefix', () => {
    expect(movedPath('notes.md', 'notes.md', 'plan.md')).toBe('plan.md');
    expect(movedPath('notes/a.md', 'notes', 'journal')).toBe('journal/a.md');
    expect(movedPath('notes-old/a.md', 'notes', 'journal')).toBeNull();
    expect(movedPath('other.md', 'notes.md', 'plan.md')).toBeNull();
  });
});

describe('createEntryMoveFollower', () => {
  it('moves the pin of a renamed file, for the binding on this root only', async () => {
    settings.set({ pinnedPathsByRig: { b1: ['a.md', 'notes.md'], b2: ['notes.md'] } });
    await createEntryMoveFollower(settings)({
      canonicalRoot: rigRoot,
      from: 'notes.md',
      to: 'plan.md',
    });
    expect(settings.get().pinnedPathsByRig).toEqual({ b1: ['a.md', 'plan.md'], b2: ['notes.md'] });
  });

  it('moves every pin and seen marker inside a renamed folder', async () => {
    settings.set({ pinnedPathsByRig: { b1: ['notes/a.md', 'notes/deep/b.md', 'notes-old/c.md'] } });
    await fixture.db.insert(rigSeenFiles).values([
      { bindingId: 'b1', relPath: 'notes/a.md', lastViewedAt: 10 },
      { bindingId: 'b1', relPath: 'top.md', lastViewedAt: 20 },
    ]);

    await createEntryMoveFollower(settings)({
      canonicalRoot: rigRoot,
      from: 'notes',
      to: 'journal',
    });

    expect(settings.get().pinnedPathsByRig.b1).toEqual([
      'journal/a.md',
      'journal/deep/b.md',
      'notes-old/c.md',
    ]);
    const seen = await fixture.db.select().from(rigSeenFiles);
    expect(
      seen
        .map((row) => [row.relPath, row.lastViewedAt])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toEqual([
      ['journal/a.md', 10],
      ['top.md', 20],
    ]);
    expect(mocks.emit).toHaveBeenCalledWith(expect.anything(), { bindingId: 'b1' });
  });

  it('leaves settings untouched when nothing pinned moved', async () => {
    settings.set({ pinnedPathsByRig: { b1: ['a.md'] } });
    const set = vi.spyOn(settings, 'set');
    await createEntryMoveFollower(settings)({
      canonicalRoot: rigRoot,
      from: 'notes.md',
      to: 'plan.md',
    });
    expect(set).not.toHaveBeenCalled();
  });
});
