import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RecentRigs from './recent-rigs';

/**
 * Sign-out pauses, and sign-in resumes, every folder linked on this
 * computer for the account: the launch sweep's list (`rig_rigs` rows plus
 * the account's bound folders in the Rig home), so a space only known by
 * its binding (steady-grove) is paused and resumed like the others. A
 * pause someone chose survives a sign-out and back in.
 */

type RigRow = { accountId: string | null; path: string; bindingId: string };

const mocks = vi.hoisted(() => ({
  runRig: vi.fn(),
  rows: [] as RigRow[],
  home: '',
}));

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('./create', () => ({ runRig: mocks.runRig }));
vi.mock('./join', () => ({ extractJsonObjects: () => [], parseJsonErrorEnvelope: () => null }));
vi.mock('./relay-name-sync-instance', () => ({ relayNameSync: {} }));
vi.mock('./spaces/rig-tools', () => ({ SPACE_NAME_MAX: 80 }));
vi.mock('./recent-rigs', async (importOriginal) => {
  const actual = await importOriginal<typeof RecentRigs>();
  return {
    ...actual,
    getLinkedPathsForAccount: async (accountId: string, ids: ReadonlySet<string> | null) =>
      actual.selectLinkedPathsForAccount(mocks.rows, await actual.listHomeFolderBindings(mocks.home), accountId, ids),
  };
});

const { pauseRigsForAccount, resumeRigsForAccount } = await import('./rig-controls');

let root: string;

async function bind(dir: string, bindingId: string): Promise<void> {
  await mkdir(join(dir, '.rig'), { recursive: true });
  await writeFile(join(dir, '.rig', 'tap-binding.local.json'), JSON.stringify({ bindingId }));
}

const pauseFile = (dir: string) => join(dir, '.rig', 'sync-paused.json');
const pauseOf = async (dir: string) => JSON.parse(await readFile(pauseFile(dir), 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rig-controls-'));
  mocks.home = join(root, 'Rig');
  mocks.rows = [];
  // `rig pause` writes `{paused, pausedAt}` (no reason); `rig resume` lifts it.
  mocks.runRig.mockReset().mockImplementation(async ([verb]: string[], cwd: string) => {
    if (verb === 'pause') await writeFile(pauseFile(cwd), JSON.stringify({ paused: true, pausedAt: '2026-10-02T09:00:00Z' }));
    else await rm(pauseFile(cwd), { force: true });
    return { kind: 'ran', exitCode: 0, stdout: '', stderr: '' };
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sign-out and sign-in', () => {
  it('pause and resume a space only known by its binding, alongside the recorded ones', async () => {
    const marketing = join(mocks.home, 'gentle-canyon');
    const steadyGrove = join(mocks.home, 'steady-grove');
    const theirs = join(mocks.home, 'their-space');
    await bind(marketing, 'bnd_5jpw95');
    await bind(steadyGrove, 'bnd_g7hvvv');
    await bind(theirs, 'bnd_theirs');
    mocks.rows = [
      { accountId: 'usr_a', path: marketing, bindingId: 'bnd_5jpw95' },
      { accountId: 'usr_b', path: theirs, bindingId: 'bnd_theirs' },
    ];
    const mine = new Set(['bnd_5jpw95', 'bnd_g7hvvv', 'bnd_theirs']);

    await pauseRigsForAccount('usr_a', mine);
    expect(mocks.runRig.mock.calls.map(([args, cwd]) => [args[0], cwd])).toEqual([
      ['pause', marketing],
      ['pause', steadyGrove],
    ]);
    expect(await pauseOf(steadyGrove)).toEqual({ paused: true, pausedAt: '2026-10-02T09:00:00Z', reason: 'signedOut' });

    mocks.runRig.mockClear();
    await resumeRigsForAccount('usr_a', mine);
    expect(mocks.runRig.mock.calls.map(([args, cwd]) => [args[0], cwd])).toEqual([
      ['resume', marketing],
      ['resume', steadyGrove],
    ]);
  });

  it('leave a pause someone chose, or a deleted space’s, paused through sign-out and back in', async () => {
    const byHand = join(mocks.home, 'warm-island');
    const deleted = join(mocks.home, 'bold-orbit');
    await bind(byHand, 'bnd_hand');
    await bind(deleted, 'bnd_gone');
    await writeFile(pauseFile(byHand), JSON.stringify({ paused: true, pausedAt: '2026-09-01T00:00:00Z' }));
    await writeFile(pauseFile(deleted), JSON.stringify({ paused: true, pausedAt: null, reason: 'deleted' }));
    const mine = new Set(['bnd_hand', 'bnd_gone']);

    await pauseRigsForAccount('usr_a', mine);
    expect(await pauseOf(byHand)).toEqual({ paused: true, pausedAt: '2026-09-01T00:00:00Z' });
    await resumeRigsForAccount('usr_a', mine);

    expect(mocks.runRig).not.toHaveBeenCalled();
    expect(await pauseOf(byHand)).toMatchObject({ paused: true });
    expect(await pauseOf(deleted)).toMatchObject({ paused: true, reason: 'deleted' });
  });

  it('touch only the recorded rows when the account’s spaces couldn’t be listed', async () => {
    const recorded = join(root, 'Code', 'rig-news');
    const steadyGrove = join(mocks.home, 'steady-grove');
    await bind(recorded, 'bnd_news');
    await bind(steadyGrove, 'bnd_g7hvvv');
    mocks.rows = [{ accountId: 'usr_a', path: recorded, bindingId: 'bnd_news' }];

    await pauseRigsForAccount('usr_a', null);
    expect(mocks.runRig.mock.calls.map(([, cwd]) => cwd)).toEqual([recorded]);
  });
});
