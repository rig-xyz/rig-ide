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

const { getRigAccountId, getRigPathsForAccount, recordRigOpened, resolveLocalPathsImpl } =
  await import('./recent-rigs');

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

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs") — the
 * registry writer's account stamping. `workspace.ts`'s `detect` is the one
 * call site (open, create-with-sync, join, and enableSync all re-open
 * through it — see that file's own header comment), so these exercise
 * `recordRigOpened` directly with the three `accountId` inputs `detect`
 * can pass: a known id (signed in), `null` (confidently signed out), and
 * `undefined` (couldn't tell — a relay hiccup while signed in).
 */
describe('recordRigOpened — account stamping', () => {
  it('a brand-new row stamps the given account id', async () => {
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_new', name: null, accountId: 'usr_a' });

    const [row] = await fixture.db.select().from(rigRigs);
    expect(row.accountId).toBe('usr_a');
  });

  it('a brand-new row stamps null when signed out', async () => {
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_new', name: null, accountId: null });

    const [row] = await fixture.db.select().from(rigRigs);
    expect(row.accountId).toBeNull();
  });

  it('a brand-new row stamps null when the caller omits accountId entirely (couldn\'t tell)', async () => {
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_new', name: null });

    const [row] = await fixture.db.select().from(rigRigs);
    expect(row.accountId).toBeNull();
  });

  it('re-opening under a different known account overwrites the stamped id', async () => {
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_existing', name: null, accountId: 'usr_a' });
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_existing', name: null, accountId: 'usr_b' });

    expect(await getRigAccountId('bnd_existing')).toBe('usr_b');
  });

  it('re-opening signed out overwrites a previously-stamped account with null', async () => {
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_existing', name: null, accountId: 'usr_a' });
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_existing', name: null, accountId: null });

    expect(await getRigAccountId('bnd_existing')).toBeNull();
  });

  it('re-opening with accountId omitted (unknown) leaves the existing stamped account untouched', async () => {
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_existing', name: null, accountId: 'usr_a' });
    await recordRigOpened({ path: '/tmp/rig', bindingId: 'bnd_existing', name: null });

    expect(await getRigAccountId('bnd_existing')).toBe('usr_a');
  });
});

describe('getRigAccountId', () => {
  it('returns undefined for a bindingId with no row at all', async () => {
    expect(await getRigAccountId('bnd_nowhere')).toBeUndefined();
  });

  it('returns null for a row with no account stamped (legacy/signed-out)', async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'bnd_legacy',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });
    expect(await getRigAccountId('bnd_legacy')).toBeNull();
  });

  it("returns the row's stamped account id", async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/tmp/rig',
      bindingId: 'bnd_owned',
      accountId: 'usr_a',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });
    expect(await getRigAccountId('bnd_owned')).toBe('usr_a');
  });
});

describe('getRigPathsForAccount', () => {
  it("resolves every local path recorded for the account, none of another account's", async () => {
    await fixture.db.insert(rigRigs).values([
      { id: 'r1', path: '/rigs/one', bindingId: 'bnd1', accountId: 'usr_a', firstOpenedAt: 1, lastOpenedAt: 1 },
      { id: 'r2', path: '/rigs/two', bindingId: 'bnd2', accountId: 'usr_b', firstOpenedAt: 1, lastOpenedAt: 1 },
      { id: 'r3', path: '/rigs/three', bindingId: 'bnd3', accountId: 'usr_a', firstOpenedAt: 1, lastOpenedAt: 1 },
    ]);

    expect(await getRigPathsForAccount('usr_a')).toEqual(['/rigs/one', '/rigs/three']);
  });
});
