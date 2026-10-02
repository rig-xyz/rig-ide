import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RecentRigs from './recent-rigs';

type RigRow = { accountId: string | null; path: string; bindingId: string };

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  bindings: vi.fn(),
  remembered: vi.fn(),
  toggleSync: vi.fn(),
  emit: vi.fn(),
  /** `rig_rigs`, as the sweep reads it. */
  rows: [] as RigRow[],
  /** The managed Rig home the sweep lists. */
  home: '',
}));

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('./account', () => ({ getCurrentAccountId: mocks.account, fetchWorkspaceBindings: mocks.bindings }));
vi.mock('./local-cache-account', () => ({ readRememberedWorkspaces: mocks.remembered }));
vi.mock('./recent-rigs', async (importOriginal) => {
  const actual = await importOriginal<typeof RecentRigs>();
  return {
    ...actual,
    // The real union, over `mocks.rows` instead of sqlite and `mocks.home` instead of ~/Rig.
    getLinkedPathsForAccount: async (accountId: string, ids: ReadonlySet<string> | null) =>
      actual.selectLinkedPathsForAccount(mocks.rows, await actual.listHomeFolderBindings(mocks.home), accountId, ids),
  };
});
vi.mock('./rig-controls', () => ({ toggleSync: mocks.toggleSync }));

const { probeDaemon, readShownSyncHealth, readSyncHealth, resetLaunchSweepForTests, resumeSyncOnLaunch, startSync } =
  await import('./sync-health');

let root: string;

async function bind(dir: string, bindingId = 'bnd_1'): Promise<void> {
  await mkdir(join(dir, '.rig', 'tap'), { recursive: true });
  await writeFile(join(dir, '.rig', 'tap-binding.local.json'), JSON.stringify({ bindingId }));
}

const relayBindings = (...ids: string[]) => ({ success: true, data: ids.map((id) => ({ id })) });

async function writePid(dir: string, pid: number): Promise<void> {
  await writeFile(join(dir, '.rig', 'tap', 'daemon.pid'), String(pid));
}

/** A process table: pid → command line. */
function deps(table: Record<number, string>) {
  return {
    isAlive: (pid: number) => pid in table,
    commandOf: async (pid: number) => table[pid] ?? null,
  };
}

const tapdFor = (dir: string) => `/Applications/Rig.app/Contents/MacOS/Rig .../@rigxyz/tapd/dist/bin.js start --dir ${dir}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sync-health-'));
  mocks.account.mockReset();
  mocks.bindings.mockReset().mockResolvedValue(relayBindings());
  mocks.remembered.mockReset().mockResolvedValue({ accountId: null, workspaces: null });
  mocks.toggleSync.mockReset();
  mocks.emit.mockReset();
  mocks.rows = [];
  mocks.home = join(root, 'no-rig-home');
  resetLaunchSweepForTests();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readSyncHealth', () => {
  it('says nothing about a folder that was never set up to sync', async () => {
    expect(await readSyncHealth(root, deps({}))).toEqual({ state: 'notSynced' });
    expect(await readSyncHealth(join(root, 'gone'), deps({}))).toEqual({ state: 'notSynced' });
  });

  it('is running when the pidfile names this folder’s tapd', async () => {
    await bind(root);
    await writePid(root, 4242);
    expect(await readSyncHealth(root, deps({ 4242: tapdFor(root) }))).toEqual({ state: 'running' });
  });

  it('is stopped after a restart: no process behind the pidfile', async () => {
    await bind(root);
    await writePid(root, 69103);
    expect(await readSyncHealth(root, deps({}))).toEqual({ state: 'stopped' });
  });

  it('is stopped when the old pid now belongs to something else', async () => {
    await bind(root);
    await writePid(root, 500);
    expect(await readSyncHealth(root, deps({ 500: '/usr/sbin/cfprefsd agent' }))).toEqual({ state: 'stopped' });
    expect(await readSyncHealth(root, deps({ 500: tapdFor('/Users/me/Rig/other') }))).toEqual({ state: 'stopped' });
  });

  it('reports a pause, with why when it says', async () => {
    await bind(root);
    await writeFile(join(root, '.rig', 'sync-paused.json'), JSON.stringify({ paused: true, pausedAt: '2026-09-30T10:00:00Z' }));
    expect(await readSyncHealth(root, deps({}))).toEqual({ state: 'paused', pausedAt: '2026-09-30T10:00:00Z', reason: null });
  });
});

describe('probeDaemon', () => {
  it('takes a live pid at its word when its command line can’t be read', async () => {
    await bind(root);
    await writePid(root, 7);
    expect(await probeDaemon(root, { isAlive: () => true, commandOf: async () => null })).toBe('running');
  });
});

describe('startSync', () => {
  it('removes a stale pidfile before `rig resume`, so resume can’t mistake a reused pid for the daemon', async () => {
    await bind(root);
    await writePid(root, 500);
    const table: Record<number, string> = { 500: '/usr/libexec/something-else' };
    mocks.toggleSync.mockImplementation(async (_verb: string, dir: string) => {
      // The pidfile was gone by the time resume ran; it writes its own.
      await expect(readFile(join(dir, '.rig', 'tap', 'daemon.pid'), 'utf8')).rejects.toThrow();
      await writePid(dir, 900);
      table[900] = tapdFor(dir);
      return { success: true, data: { paused: false } };
    });
    const result = await startSync(root, deps(table));
    expect(mocks.toggleSync).toHaveBeenCalledWith('resume', root);
    expect(result).toEqual({ success: true, data: { state: 'running' } });
  });

  it('remembers why it couldn’t start, and reports it until sync runs', async () => {
    await bind(root);
    mocks.toggleSync.mockResolvedValue({ success: false, error: { message: 'Bad CPU type in executable' } });
    const result = await startSync(root, deps({}));
    expect(result.success).toBe(false);
    expect(await readSyncHealth(root, deps({}))).toEqual({ state: 'error', message: 'Bad CPU type in executable' });
    await writePid(root, 1);
    expect(await readSyncHealth(root, deps({ 1: tapdFor(root) }))).toEqual({ state: 'running' });
    await rm(join(root, '.rig', 'tap', 'daemon.pid'));
    expect(await readSyncHealth(root, deps({}))).toEqual({ state: 'stopped' });
  });
});

describe('resumeSyncOnLaunch', () => {
  it('starts every stopped rig of the signed-in account, and leaves paused and running ones alone', async () => {
    const stopped = join(root, 'stopped');
    const paused = join(root, 'paused');
    const running = join(root, 'running');
    const local = join(root, 'local-only');
    for (const dir of [stopped, paused, running]) await bind(dir);
    await mkdir(local, { recursive: true });
    await writeFile(join(paused, '.rig', 'sync-paused.json'), JSON.stringify({ paused: true }));
    await writePid(running, 10);
    await writePid(stopped, 11);
    mocks.account.mockResolvedValue({ status: 'known', id: 'usr_a' });
    mocks.rows = [stopped, paused, running, local, join(root, 'deleted')].map((path, i) => ({
      accountId: 'usr_a',
      path,
      bindingId: `bnd_${i}`,
    }));
    mocks.toggleSync.mockResolvedValue({ success: true, data: { paused: false } });

    await resumeSyncOnLaunch({ deps: deps({ 10: tapdFor(running) }), delays: [] });

    expect(mocks.toggleSync.mock.calls).toEqual([['resume', stopped]]);
  });

  it('starts a space only known by its binding: in the Rig home, bound to one of the account’s spaces, never opened here', async () => {
    mocks.home = join(root, 'Rig');
    const steadyGrove = join(mocks.home, 'steady-grove');
    const someoneElses = join(mocks.home, 'other-account');
    const notMine = join(mocks.home, 'not-a-member');
    await bind(steadyGrove, 'bnd_g7hvvv');
    await writePid(steadyGrove, 69103); // dead since a reboot
    await bind(someoneElses, 'bnd_theirs');
    await bind(notMine, 'bnd_stranger');
    mocks.rows = [{ accountId: 'usr_b', path: someoneElses, bindingId: 'bnd_theirs' }];
    mocks.account.mockResolvedValue({ status: 'known', id: 'usr_a' });
    mocks.bindings.mockResolvedValue(relayBindings('bnd_g7hvvv', 'bnd_theirs'));
    mocks.toggleSync.mockResolvedValue({ success: false, error: { message: 'stop here' } });

    await resumeSyncOnLaunch({ deps: deps({}), delays: [] });

    expect(mocks.toggleSync.mock.calls).toEqual([['resume', steadyGrove]]);
  });

  it('falls back to the account’s remembered list when the relay can’t list it, and adds no home folders without one', async () => {
    mocks.home = join(root, 'Rig');
    const space = join(mocks.home, 'warm-island');
    await bind(space, 'bnd_w');
    mocks.account.mockResolvedValue({ status: 'known', id: 'usr_a' });
    mocks.bindings.mockResolvedValue({ success: false, error: { kind: 'network', message: 'offline' } });
    mocks.toggleSync.mockResolvedValue({ success: false, error: { message: 'stop here' } });

    await resumeSyncOnLaunch({ deps: deps({}), delays: [] });
    expect(mocks.toggleSync).not.toHaveBeenCalled();

    resetLaunchSweepForTests();
    mocks.remembered.mockResolvedValue({ accountId: 'usr_a', workspaces: { savedAt: 1, bindings: [{ id: 'bnd_w' }] } });
    await resumeSyncOnLaunch({ deps: deps({}), delays: [] });
    expect(mocks.toggleSync.mock.calls).toEqual([['resume', space]]);
  });

  it('waits for the account when the relay can’t tell yet, and starts nothing when signed out', async () => {
    const sleep = vi.fn(async () => undefined);
    mocks.account.mockResolvedValueOnce({ status: 'unknown' }).mockResolvedValueOnce({ status: 'signedOut' });
    await resumeSyncOnLaunch({ deps: deps({}), delays: [1, 2], sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(mocks.bindings).not.toHaveBeenCalled();
    expect(mocks.toggleSync).not.toHaveBeenCalled();
  });
});

describe('readShownSyncHealth: no false alarm at launch', () => {
  it('reads a stopped folder as starting until the sweep has planned, then as stopped when it isn’t the sweep’s to start', async () => {
    await bind(root);
    expect(await readShownSyncHealth(root, deps({}))).toEqual({ state: 'starting' });

    mocks.account.mockResolvedValue({ status: 'known', id: 'usr_a' }); // `root` isn't one of theirs
    await resumeSyncOnLaunch({ deps: deps({}), delays: [] });

    expect(await readShownSyncHealth(root, deps({}))).toEqual({ state: 'stopped' });
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'rig:sync-health-changed' }), {
      path: null,
    });
  });

  it('keeps reading starting while the sweep waits for the account', async () => {
    await bind(root);
    let shownWhileWaiting: unknown;
    const sleep = vi.fn(async () => {
      shownWhileWaiting = await readShownSyncHealth(root, deps({}));
    });
    mocks.account.mockResolvedValueOnce({ status: 'unknown' }).mockResolvedValueOnce({ status: 'signedOut' });
    await resumeSyncOnLaunch({ deps: deps({}), delays: [1], sleep });
    expect(shownWhileWaiting).toEqual({ state: 'starting' });
    // Signed out: the sweep is done, and says what's really there.
    expect(await readShownSyncHealth(root, deps({}))).toEqual({ state: 'stopped' });
  });

  it('marks every folder it will start before starting the first, and announces each as it ends', async () => {
    const first = join(root, 'gentle-canyon'); // shown as "rig-marketing": keyed by folder, never by name
    const second = join(root, 'bright-coast');
    await bind(first, 'bnd_5jpw95');
    await bind(second, 'bnd_dsbqy3');
    mocks.rows = [
      { accountId: 'usr_a', path: first, bindingId: 'bnd_5jpw95' },
      { accountId: 'usr_a', path: second, bindingId: 'bnd_dsbqy3' },
    ];
    mocks.account.mockResolvedValue({ status: 'known', id: 'usr_a' });
    const table: Record<number, string> = {};
    const seen: Record<string, unknown> = {};
    mocks.toggleSync.mockImplementation(async (_verb: string, dir: string) => {
      if (dir === first) seen.secondWhileFirstStarts = await readShownSyncHealth(second, deps(table));
      const pid = dir === first ? 101 : 102;
      await writePid(dir, pid);
      table[pid] = tapdFor(dir);
      return { success: true, data: { paused: false } };
    });

    await resumeSyncOnLaunch({ deps: deps(table), delays: [] });

    expect(seen.secondWhileFirstStarts).toEqual({ state: 'starting' });
    expect(await readShownSyncHealth(first, deps(table))).toEqual({ state: 'running' });
    expect(await readShownSyncHealth(`${second}/`, deps(table))).toEqual({ state: 'running' });
    const announced = mocks.emit.mock.calls.map(([, data]) => (data as { path: string | null }).path);
    expect(announced).toContain(first);
    expect(announced).toContain(second);
  });
});
