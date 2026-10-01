import { execFile } from 'node:child_process';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { SyncHealth } from '@shared/rig/sync-health';
import { getCurrentAccountId } from './account';
import { existsAsDirectory, getRigPathsForAccount } from './recent-rigs';
import { toggleSync } from './rig-controls';

/**
 * Is each rig/space actually syncing on this computer — and making sure it
 * is after a restart.
 *
 * The sync daemon (tapd) is a detached process per folder, started by
 * `rig attach`/`rig init --live`/`rig resume`, with its pid in
 * `.rig/tap/daemon.pid`. Nothing supervises it: a reboot (a macOS upgrade,
 * say) ends every daemon, and nothing started them again — the app never
 * started daemons at launch, only on attach/create/resume. So spaces went
 * quietly out of date, and the app still called them "Backed up".
 *
 * Two halves:
 *   - `readSyncHealth`: the state, read off the folder (paused flag, binding,
 *     pidfile + is that pid really this folder's tapd) — never a relay call.
 *   - `resumeSyncOnLaunch`: at launch, every rig the signed-in account has
 *     on this computer that should be syncing (bound, not paused) and isn't
 *     gets `rig resume`. A paused rig stays paused: that was someone's
 *     choice, and the app says so instead.
 *
 * A pidfile outlives a reboot, and pids get reused: the old number can
 * belong to some other process by now. `rig resume` only checks the pid is
 * alive, so it would say "already running" and start nothing. Before
 * resuming, a pidfile whose process isn't this folder's tapd is removed.
 */

const PS_TIMEOUT_MS = 2_000;
/** Launch sweep: how long to wait for the account to be known (relay unreachable right after boot) before each retry. */
const ACCOUNT_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];

export type SyncHealthDeps = {
  /** Whether a process with this pid exists (signal 0). */
  isAlive: (pid: number) => boolean;
  /** That process's command line, or null when it can't be read. */
  commandOf: (pid: number) => Promise<string | null>;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

const defaultDeps: SyncHealthDeps = { isAlive, commandOf };

/** Starts the app is running (or ran and failed) — what `readSyncHealth` reports over what's on disk. */
const starting = new Set<string>();
const startErrors = new Map<string, string>();

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readPaused(root: string): Promise<{ pausedAt: string | null; reason: string | null } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, '.rig', 'sync-paused.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.paused !== true) return null;
    return {
      pausedAt: typeof record.pausedAt === 'string' ? record.pausedAt : null,
      reason: typeof record.reason === 'string' ? record.reason : null,
    };
  } catch {
    return null;
  }
}

function pidfileOf(root: string): string {
  return join(root, '.rig', 'tap', 'daemon.pid');
}

async function readPid(root: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(pidfileOf(root), 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * This folder's daemon, as its pidfile says: `running` only when that pid is
 * alive AND is a `tapd start --dir <root>` (a reused pid is `stale`). When
 * the command line can't be read at all, a live pid is taken at its word.
 */
export async function probeDaemon(
  root: string,
  deps: SyncHealthDeps = defaultDeps
): Promise<'running' | 'stale' | 'none'> {
  const pid = await readPid(root);
  if (pid === null) return 'none';
  if (!deps.isAlive(pid)) return 'stale';
  const command = await deps.commandOf(pid);
  if (command === null) return 'running';
  if (!command.includes('tapd')) return 'stale';
  // tapd is started from the folder's real path (`rig resume` passes its
  // cwd), which may differ from the path on record (a symlink, /private).
  const base = root.replace(/\/+$/, '');
  const real = await realpath(root).catch(() => base);
  return [base, real].some((dir) => command.includes(`--dir ${dir}`)) ? 'running' : 'stale';
}

/** Whether this rig is bound to the relay (the file `rig attach`/`rig init --live` write). */
function isBound(root: string): Promise<boolean> {
  return fileExists(join(root, '.rig', 'tap-binding.local.json'));
}

export async function readSyncHealth(root: string, deps: SyncHealthDeps = defaultDeps): Promise<SyncHealth> {
  if (!(await existsAsDirectory(root)) || !(await isBound(root))) return { state: 'notSynced' };
  const paused = await readPaused(root);
  if (paused) return { state: 'paused', ...paused };
  if (starting.has(root)) return { state: 'starting' };
  if ((await probeDaemon(root, deps)) === 'running') {
    startErrors.delete(root);
    return { state: 'running' };
  }
  const failed = startErrors.get(root);
  return failed ? { state: 'error', message: failed } : { state: 'stopped' };
}

/**
 * Starts (or resumes) syncing for one folder: clears a stale pidfile, then
 * `rig resume` — which also lifts a pause. Answers the state afterwards; a
 * failure is remembered so the Room and Home can say what went wrong.
 */
export async function startSync(root: string, deps: SyncHealthDeps = defaultDeps): Promise<Result<SyncHealth, { message: string }>> {
  if (starting.has(root)) return ok({ state: 'starting' });
  starting.add(root);
  try {
    if ((await probeDaemon(root, deps)) === 'stale') {
      await rm(pidfileOf(root), { force: true }).catch(() => undefined);
    }
    const result = await toggleSync('resume', root);
    starting.delete(root);
    if (!result.success) {
      startErrors.set(root, result.error.message);
      return err(result.error);
    }
    const health = await readSyncHealth(root, deps);
    if (health.state === 'stopped') {
      const message = 'The sync process exited right after starting.';
      startErrors.set(root, message);
      return err({ message });
    }
    startErrors.delete(root);
    return ok(health);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startErrors.set(root, message);
    return err({ message });
  } finally {
    starting.delete(root);
  }
}

/** Whether the launch sweep should start this folder: there, bound, not paused, and no daemon of its own running. */
export async function shouldStartAtLaunch(root: string, deps: SyncHealthDeps = defaultDeps): Promise<boolean> {
  const health = await readSyncHealth(root, deps);
  return health.state === 'stopped' || health.state === 'error';
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launch: bring back sync for every rig the signed-in account has on this
 * computer. Best-effort throughout and never throws. An account that can't
 * be told yet (the relay unreachable right after a reboot) is asked again a
 * few times; signed out, nothing starts (sign-out paused them on purpose).
 */
export async function resumeSyncOnLaunch(
  opts: { deps?: SyncHealthDeps; delays?: readonly number[]; sleep?: (ms: number) => Promise<unknown> } = {}
): Promise<void> {
  const deps = opts.deps ?? defaultDeps;
  const delays = opts.delays ?? ACCOUNT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? wait;
  try {
    let account = await getCurrentAccountId();
    for (const delay of delays) {
      if (account.status !== 'unknown') break;
      await sleep(delay);
      account = await getCurrentAccountId();
    }
    if (account.status !== 'known') {
      log.info('rig: launch sync sweep skipped', { account: account.status });
      return;
    }
    const paths = await getRigPathsForAccount(account.id);
    for (const path of paths) {
      if (!(await shouldStartAtLaunch(path, deps))) continue;
      const result = await startSync(path, deps);
      if (result.success) log.info('rig: started sync at launch', { path });
      else log.warn('rig: could not start sync at launch', { path, error: result.error.message });
    }
  } catch (error) {
    log.warn('rig: launch sync sweep failed', { error: String(error) });
  }
}

export const rigSyncHealthController = createRPCController({
  /** Each folder's sync state on this computer, keyed by the path asked for. */
  get: async ({ paths }: { paths: string[] }): Promise<Record<string, SyncHealth>> => {
    const entries = await Promise.all(paths.map(async (path) => [path, await readSyncHealth(path)] as const));
    return Object.fromEntries(entries);
  },
  /** The Room/Home "Resume" / "Start syncing" / "Try again" button. */
  start: ({ path }: { path: string }) => startSync(path),
});
