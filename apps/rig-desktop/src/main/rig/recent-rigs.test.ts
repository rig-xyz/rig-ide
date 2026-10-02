import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

// `recent-rigs.ts` imports `@main/db/client` at module scope, which opens a
// real (Electron-compiled) better-sqlite3 handle as a side effect of import
// — fine under the `main-db`/`migrations` projects (see
// `recent-rigs.db.test.ts`), fatal under this file's plain `node` project.
// `selectRigPathsForAccount` below never touches `db` at all, so the same
// mock-before-import trick `recent-rigs.db.test.ts` uses for its own,
// db-touching tests is enough here too — it just never needs a real
// fixture on top of it.
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { listHomeFolderBindings, selectLinkedPathsForAccount, selectRigPathsForAccount } = await import('./recent-rigs');

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs") — the
 * pure half of "which rigs does `auth.ts`'s logout (pause) / login
 * (resume) hook act on." Plain data in, plain data out; the db-backed
 * wrapper (`getRigPathsForAccount`) is a one-line read + this same
 * function, not separately tested.
 */
describe('selectRigPathsForAccount', () => {
  const rows = [
    { accountId: 'usr_a', path: '/rigs/one' },
    { accountId: 'usr_b', path: '/rigs/two' },
    { accountId: null, path: '/rigs/legacy' },
    { accountId: 'usr_a', path: '/rigs/three' },
  ];

  it('returns every path recorded for the given account, in row order', () => {
    expect(selectRigPathsForAccount(rows, 'usr_a')).toEqual(['/rigs/one', '/rigs/three']);
  });

  it('never returns a null-account (legacy/unknown) row, even for an account that legitimately has none', () => {
    expect(selectRigPathsForAccount(rows, 'usr_c')).toEqual([]);
  });

  it('an empty row set is just an empty result', () => {
    expect(selectRigPathsForAccount([], 'usr_a')).toEqual([]);
  });

  it("does not cross accounts — usr_b never sees usr_a's rigs", () => {
    expect(selectRigPathsForAccount(rows, 'usr_b')).toEqual(['/rigs/two']);
  });
});

/**
 * The launch sync sweep's list: `rig_rigs` misses a space that was only
 * ever attached by the CLI into the Rig home (steady-grove, 0.4.7), so the
 * account's own bound folders there count too.
 */
describe('selectLinkedPathsForAccount', () => {
  const rows = [
    { accountId: 'usr_a', path: '/Users/me/Rig/gentle-canyon', bindingId: 'bnd_marketing' },
    { accountId: 'usr_b', path: '/Users/me/Rig/their-space', bindingId: 'bnd_theirs' },
  ];
  const home = [
    { path: '/Users/me/Rig/gentle-canyon', bindingId: 'bnd_marketing' },
    { path: '/Users/me/Rig/steady-grove', bindingId: 'bnd_g7hvvv' },
    { path: '/Users/me/Rig/their-space', bindingId: 'bnd_theirs' },
    { path: '/Users/me/Rig/stranger', bindingId: 'bnd_stranger' },
  ];
  const mine = new Set(['bnd_marketing', 'bnd_g7hvvv', 'bnd_theirs']);

  it('adds a home folder known only by its binding, once, and never another account’s or a non-member’s', () => {
    expect(selectLinkedPathsForAccount(rows, home, 'usr_a', mine)).toEqual([
      '/Users/me/Rig/gentle-canyon',
      '/Users/me/Rig/steady-grove',
    ]);
  });

  it('adds no home folders when the account’s spaces can’t be listed', () => {
    expect(selectLinkedPathsForAccount(rows, home, 'usr_a', null)).toEqual(['/Users/me/Rig/gentle-canyon']);
  });
});

describe('listHomeFolderBindings', () => {
  it('lists the bound folders directly inside the Rig home, by their own binding file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rig-home-'));
    try {
      await mkdir(join(home, 'steady-grove', '.rig'), { recursive: true });
      await writeFile(join(home, 'steady-grove', '.rig', 'tap-binding.local.json'), '{"bindingId":"bnd_g7hvvv"}');
      await mkdir(join(home, 'local-only', '.rig'), { recursive: true });
      await mkdir(join(home, 'broken', '.rig'), { recursive: true });
      await writeFile(join(home, 'broken', '.rig', 'tap-binding.local.json'), 'not json');
      await writeFile(join(home, 'notes.md'), '');
      expect(await listHomeFolderBindings(home)).toEqual([
        { path: join(home, 'steady-grove'), bindingId: 'bnd_g7hvvv' },
      ]);
      expect(await listHomeFolderBindings(join(home, 'missing'))).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
