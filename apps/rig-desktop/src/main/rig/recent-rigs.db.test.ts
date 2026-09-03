import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const {
  forgetRig,
  getRigAccountId,
  getRigPathsForAccount,
  hasRigMarker,
  recentRigsImpl,
  recordRigOpened,
  resolveLocalPathsImpl,
} = await import('./recent-rigs');

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

/**
 * Dead-end fix (rail-honesty round): whether a recorded path still carries
 * a rig marker at all — `recentRigsImpl`'s `notARigAnymore` flag and the
 * not-a-rig card's "Remove from your rigs" both key off this.
 */
describe('hasRigMarker', () => {
  it('true for a folder with its own rig.toml (a local-only or synced rig manifest)', async () => {
    const dir = join(home, 'with-toml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rig.toml'), '[rig]\nname = "x"\n');
    expect(await hasRigMarker(dir)).toBe(true);
  });

  it('true for a folder with a .rig/ directory, even with no rig.toml', async () => {
    const dir = join(home, 'with-dot-rig');
    mkdirSync(join(dir, '.rig'), { recursive: true });
    expect(await hasRigMarker(dir)).toBe(true);
  });

  it('false for a folder that exists but carries neither marker', async () => {
    const dir = join(home, 'plain-folder');
    mkdirSync(dir, { recursive: true });
    expect(await hasRigMarker(dir)).toBe(false);
  });

  it('false for a folder that no longer exists at all — same tolerant default as existsAsDirectory', async () => {
    expect(await hasRigMarker(join(home, 'never-existed'))).toBe(false);
  });

  it('false when rig.toml exists but is a directory, not a file (a stray, not a real manifest)', async () => {
    const dir = join(home, 'toml-is-a-dir');
    mkdirSync(join(dir, 'rig.toml'), { recursive: true });
    expect(await hasRigMarker(dir)).toBe(false);
  });
});

/**
 * Dead-end fix: the "Remove from your rigs" action — a plain, local-only
 * delete. `rig-controls.ts`'s move/pause/resume all shell the CLI first;
 * this deliberately doesn't — there is no folder-side undo for a row whose
 * folder may already be gone.
 */
describe('forgetRig', () => {
  it('deletes the row for the given bindingId', async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: '/rigs/gone',
      bindingId: 'bnd_stale',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    await forgetRig('bnd_stale');

    const rows = await fixture.db.select().from(rigRigs);
    expect(rows).toEqual([]);
  });

  it('never touches a different bindingId\'s row', async () => {
    await fixture.db.insert(rigRigs).values([
      { id: 'r1', path: '/rigs/stale', bindingId: 'bnd_stale', firstOpenedAt: 1, lastOpenedAt: 1 },
      { id: 'r2', path: '/rigs/keep', bindingId: 'bnd_keep', firstOpenedAt: 1, lastOpenedAt: 1 },
    ]);

    await forgetRig('bnd_stale');

    const rows = await fixture.db.select().from(rigRigs);
    expect(rows.map((r) => r.bindingId)).toEqual(['bnd_keep']);
  });

  it('a bindingId with no row at all is simply a no-op — never throws', async () => {
    await expect(forgetRig('bnd_nowhere')).resolves.toBeUndefined();
  });
});

/**
 * Rail-honesty round: `recentRigsImpl`'s own `notARigAnymore` enrichment —
 * `resolveLocalPathsImpl`'s neighboring describe block above covers the
 * separate "known local paths for a binding" read; this covers the row
 * list `home.tsx`'s rail actually renders.
 */
describe('recentRigsImpl — notARigAnymore enrichment', () => {
  it('false for a row whose path still has a rig.toml', async () => {
    const dir = join(home, 'still-a-rig');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rig.toml'), '[rig]\nname = "x"\n');
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: dir,
      bindingId: 'bnd_healthy',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const [row] = await recentRigsImpl();
    expect(row).toMatchObject({ bindingId: 'bnd_healthy', notARigAnymore: false });
  });

  it('true for a row whose folder exists but lost its rig markers — the stale-registry-entry bug', async () => {
    const dir = join(home, 'repurposed-folder');
    mkdirSync(dir, { recursive: true });
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: dir,
      bindingId: 'bnd_stale',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const [row] = await recentRigsImpl();
    expect(row).toMatchObject({ bindingId: 'bnd_stale', notARigAnymore: true });
  });

  it('true for a row whose folder was deleted entirely, same as one merely repurposed', async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: join(home, 'deleted-entirely'),
      bindingId: 'bnd_deleted',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const [row] = await recentRigsImpl();
    expect(row).toMatchObject({ bindingId: 'bnd_deleted', notARigAnymore: true });
  });

  it('never filters a notARigAnymore row out of the list — only flags it', async () => {
    await fixture.db.insert(rigRigs).values({
      id: 'r1',
      path: join(home, 'still-listed'),
      bindingId: 'bnd_still_listed',
      firstOpenedAt: 1,
      lastOpenedAt: 1,
    });

    const rows = await recentRigsImpl();
    expect(rows.map((r) => r.bindingId)).toContain('bnd_still_listed');
  });
});
