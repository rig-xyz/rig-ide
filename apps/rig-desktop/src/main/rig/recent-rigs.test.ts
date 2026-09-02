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

const { selectRigPathsForAccount } = await import('./recent-rigs');

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
