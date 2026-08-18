import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { rigRigs } from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { resolveLocalPathsImpl } = await import('./recent-rigs');

let fixture: Awaited<ReturnType<typeof openFixture>>;
let home: string;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  home = mkdtempSync(join(tmpdir(), 'rig-recent-home-'));
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
  rmSync(home, { recursive: true, force: true });
});

/**
 * Correction round: the filesystem scan is gone entirely — known-local is
 * `rig_rigs` rows only, existence-verified. No directory enumeration, ever
 * (Dylan: "not sure people would be very excited about having an app scan
 * their folders" — right call, deleted rather than tuned down).
 */
describe('resolveLocalPathsImpl', () => {
  it('resolves a bindingId that rig_rigs has a still-existing path for', async () => {
    const rigDir = join(home, 'wherever-it-lives');
    mkdirSync(rigDir, { recursive: true });
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: rigDir,
      bindingId: 'bnd_known',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const result = await resolveLocalPathsImpl(['bnd_known']);
    expect(result).toEqual({ bnd_known: rigDir });
  });

  it('a binding present in rig_rigs but whose recorded path no longer exists is omitted, not returned stale', async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: join(home, 'deleted-folder'),
      bindingId: 'bnd_gone',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const result = await resolveLocalPathsImpl(['bnd_gone']);
    expect(result).toEqual({});
  });

  it('a binding with no rig_rigs row at all is simply absent — never a null entry, and no scan is attempted', async () => {
    const result = await resolveLocalPathsImpl(['bnd_nowhere']);
    expect(result).toEqual({});
    expect('bnd_nowhere' in result).toBe(false);
  });

  it('only resolves the bindingIds actually asked for, even when other rigs are known locally', async () => {
    const rigDir = join(home, 'some-other-rig');
    mkdirSync(rigDir, { recursive: true });
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: rigDir,
      bindingId: 'bnd_irrelevant',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const result = await resolveLocalPathsImpl(['bnd_something_else']);
    expect(result).toEqual({});
  });
});
