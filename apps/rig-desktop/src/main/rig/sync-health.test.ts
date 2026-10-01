import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  paths: vi.fn(),
  toggleSync: vi.fn(),
}));

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('./account', () => ({ getCurrentAccountId: mocks.account }));
vi.mock('./recent-rigs', async () => {
  const { stat } = await import('node:fs/promises');
  return {
    getRigPathsForAccount: mocks.paths,
    existsAsDirectory: (path: string) =>
      stat(path)
        .then((s) => s.isDirectory())
        .catch(() => false),
  };
});
vi.mock('./rig-controls', () => ({ toggleSync: mocks.toggleSync }));

const { probeDaemon, readSyncHealth, resumeSyncOnLaunch, startSync } = await import('./sync-health');

let root: string;

async function bind(dir: string): Promise<void> {
  await mkdir(join(dir, '.rig', 'tap'), { recursive: true });
  await writeFile(join(dir, '.rig', 'tap-binding.local.json'), '{"bindingId":"bnd_1"}');
}

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
  mocks.paths.mockReset();
  mocks.toggleSync.mockReset();
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
    mocks.paths.mockResolvedValue([stopped, paused, running, local, join(root, 'deleted')]);
    mocks.toggleSync.mockResolvedValue({ success: true, data: { paused: false } });

    await resumeSyncOnLaunch({ deps: deps({ 10: tapdFor(running) }), delays: [] });

    expect(mocks.paths).toHaveBeenCalledWith('usr_a');
    expect(mocks.toggleSync.mock.calls).toEqual([['resume', stopped]]);
  });

  it('waits for the account when the relay can’t tell yet, and starts nothing when signed out', async () => {
    const sleep = vi.fn(async () => undefined);
    mocks.account.mockResolvedValueOnce({ status: 'unknown' }).mockResolvedValueOnce({ status: 'signedOut' });
    await resumeSyncOnLaunch({ deps: deps({}), delays: [1, 2], sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(mocks.paths).not.toHaveBeenCalled();
    expect(mocks.toggleSync).not.toHaveBeenCalled();
  });
});
