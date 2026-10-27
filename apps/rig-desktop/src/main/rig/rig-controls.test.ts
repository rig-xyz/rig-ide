import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Home from './home';
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
  open: new Set<string>(),
  inFlight: new Set<string>(),
  movedTo: [] as Array<{ bindingId: string; path: string }>,
}));

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('./create', () => ({ runRig: mocks.runRig }));
vi.mock('./join', () => ({
  extractJsonObjects: (text: string) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  parseJsonErrorEnvelope: () => null,
}));
vi.mock('./home', async (importOriginal) => ({
  ...(await importOriginal<typeof Home>()),
  readRigHomeDir: async () => mocks.home,
}));
vi.mock('./file-root-registry', () => ({
  rigFileRootRegistry: { isOpen: async (path: string) => mocks.open.has(path) },
}));
vi.mock('./spaces/session-store-instance', () => ({
  spaceHasRunInFlight: (bindingId: string) => mocks.inFlight.has(bindingId),
}));
vi.mock('./relay-name-sync-instance', () => ({ relayNameSync: { pushRename: async () => undefined } }));
vi.mock('./spaces/rig-tools', () => ({ SPACE_NAME_MAX: 80 }));
vi.mock('./recent-rigs', async (importOriginal) => {
  const actual = await importOriginal<typeof RecentRigs>();
  return {
    ...actual,
    updateRigName: async () => undefined,
    updateRigPath: async (bindingId: string, path: string) => {
      mocks.movedTo.push({ bindingId, path });
    },
    getLinkedPathsForAccount: async (accountId: string, ids: ReadonlySet<string> | null) =>
      actual.selectLinkedPathsForAccount(mocks.rows, await actual.listHomeFolderBindings(mocks.home), accountId, ids),
  };
});

const { pauseRigsForAccount, renameRig, resumeRigsForAccount } = await import('./rig-controls');

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
  mocks.open.clear();
  mocks.inFlight.clear();
  mocks.movedTo = [];
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

describe('rename', () => {
  it('rewrites rig.toml and asks the CLI to retitle the agent brief, best effort', async () => {
    const dir = join(root, 'quick-trail');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'rig.toml'), '[rig]\nname = "quick-trail"\n');
    mocks.runRig.mockReset().mockResolvedValue({ kind: 'ran', exitCode: 1, stdout: '', stderr: 'Unknown command "rename"' });

    const result = await renameRig('bnd_1', dir, 'rig-jay');

    // Outside the Rig home: a folder someone put there is theirs to name.
    expect(result).toEqual({ success: true, data: { name: 'rig-jay', folder: { moved: false, reason: 'outside-home' } } });
    expect(await readFile(join(dir, 'rig.toml'), 'utf8')).toContain('name = "rig-jay"');
    expect(mocks.runRig).toHaveBeenCalledWith(['rename', 'rig-jay', '--json'], dir, expect.any(Number));
  });

  describe('the folder follows the name', () => {
    async function space(folder: string, name: string): Promise<string> {
      const dir = join(mocks.home, folder);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'rig.toml'), `[rig]\nname = "${name}"\n`);
      return dir;
    }

    beforeEach(() => {
      // `rig move --to <dest>` moves the folder and says where.
      mocks.runRig.mockReset().mockImplementation(async (args: string[]) => {
        if (args[0] !== 'move') return { kind: 'ran', exitCode: 0, stdout: '', stderr: '' };
        const { rename } = await import('node:fs/promises');
        await rename(args[1]!, args[3]!);
        return { kind: 'ran', exitCode: 0, stdout: `${JSON.stringify({ from: args[1], to: args[3] })}\n`, stderr: '' };
      });
    });

    it('moves clear-harbor to rig-feedback through rig move, and records the new path', async () => {
      const dir = await space('clear-harbor', 'clear-harbor');
      const result = await renameRig('bnd_1', dir, 'rig-feedback');

      const to = join(mocks.home, 'rig-feedback');
      expect(mocks.runRig).toHaveBeenCalledWith(['move', dir, '--to', to, '--json'], dir, expect.any(Number));
      expect(result).toMatchObject({ success: true, data: { folder: { moved: true, path: to } } });
      expect(await readFile(join(to, 'rig.toml'), 'utf8')).toContain('name = "rig-feedback"');
      expect(mocks.movedTo).toEqual([{ bindingId: 'bnd_1', path: to }]);
    });

    it('takes a suffix only on a real clash, and leaves a folder already named for it', async () => {
      await mkdir(join(mocks.home, 'rig-feedback'), { recursive: true });
      const dir = await space('clear-harbor', 'clear-harbor');
      const moved = await renameRig('bnd_1', dir, 'rig-feedback');
      expect(moved).toMatchObject({ data: { folder: { moved: true, path: join(mocks.home, 'rig-feedback-2') } } });

      mocks.runRig.mockClear();
      const again = await renameRig('bnd_1', join(mocks.home, 'rig-feedback-2'), 'rig-feedback');
      expect(again).toMatchObject({ data: { folder: { moved: false, reason: 'matches' } } });
      expect(mocks.runRig).not.toHaveBeenCalledWith(expect.arrayContaining(['move']), expect.anything(), expect.anything());
    });

    it('never moves a folder open in a window or with a run in flight; it says why', async () => {
      const open = await space('calm-trail', 'calm-trail');
      mocks.open.add(open);
      expect(await renameRig('bnd_open', open, 'mktg-emails')).toMatchObject({
        data: { name: 'mktg-emails', folder: { moved: false, reason: 'open' } },
      });

      const busy = await space('gentle-canyon', 'gentle-canyon');
      mocks.inFlight.add('bnd_busy');
      expect(await renameRig('bnd_busy', busy, 'playdrop-rig')).toMatchObject({
        data: { folder: { moved: false, reason: 'busy' } },
      });
      expect(mocks.runRig).not.toHaveBeenCalledWith(expect.arrayContaining(['move']), expect.anything(), expect.anything());
      expect(mocks.movedTo).toEqual([]);
    });
  });
});
