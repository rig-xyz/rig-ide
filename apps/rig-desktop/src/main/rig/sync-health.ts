import { execFile } from 'node:child_process';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigSyncHealthChangedChannel, type SyncHealth } from '@shared/rig/sync-health';
import { fetchWorkspaceBindings, getCurrentAccountId } from './account';
import { readRememberedWorkspaces } from './local-cache-account';
import { existsAsDirectory, getLinkedPathsForAccount } from './recent-rigs';
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
 *     choice, and the app says so instead. "On this computer" is the
 *     account's `rig_rigs` rows plus the bound folders in the Rig home whose
 *     binding is the account's (`getLinkedPathsForAccount`): a space the CLI
 *     attached there never went through the app's open.
 *
 * Until the sweep has worked out which folders it will start, and while it
 * gets to each one, a stopped folder reads as `starting` to the renderer
 * (`readShownSyncHealth`): at launch every daemon is down for the same few
 * seconds the sweep takes to start it, and that isn't news.
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
  /** A file's last-modified time in ms, or null when it can't be read. Omitted: from disk. */
  modifiedAt?: (path: string) => Promise<number | null>;
  /** Asks a process to stop (SIGTERM). Omitted: `process.kill`. */
  stop?: (pid: number) => void;
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

function modifiedAt(path: string): Promise<number | null> {
  return stat(path).then(
    (info) => info.mtimeMs,
    () => null
  );
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

const defaultDeps: SyncHealthDeps = { isAlive, commandOf, modifiedAt, stop: stopProcess };

/** How long a stopped daemon gets to exit before the sweep starts a new one anyway. */
const STOP_WAIT_MS = 5_000;

/** Starts the app is running (or ran and failed) — what `readSyncHealth` reports over what's on disk. */
const starting = new Set<string>();
const startErrors = new Map<string, string>();

/** The launch sweep: whether it has decided what to start yet, and the folders it has yet to get to. */
const sweep = { planned: false, pending: new Set<string>() };

/** Tests only: back to a fresh launch. */
export function resetLaunchSweepForTests(): void {
  sweep.planned = false;
  sweep.pending.clear();
}

function keyOf(root: string): string {
  return resolve(root);
}

/** Tells every window to read `path`'s sync state again (null: every folder's). */
function announce(path: string | null): void {
  try {
    events.emit(rigSyncHealthChangedChannel, { path });
  } catch (error) {
    log.warn('rig: could not announce a sync state change', { error: String(error) });
  }
}

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
  const key = keyOf(root);
  if (starting.has(key)) return { state: 'starting' };
  if ((await probeDaemon(root, deps)) === 'running') {
    startErrors.delete(key);
    return { state: 'running' };
  }
  const failed = startErrors.get(key);
  return failed ? { state: 'error', message: failed } : { state: 'stopped' };
}

/**
 * What the Room and Home show: `readSyncHealth`, except a stopped folder
 * reads as `starting` while the launch sweep hasn't planned yet or has it
 * still to start. Keyed by the folder's path, never its display name.
 */
export async function readShownSyncHealth(root: string, deps: SyncHealthDeps = defaultDeps): Promise<SyncHealth> {
  const health = await readSyncHealth(root, deps);
  if (health.state === 'stopped' && (!sweep.planned || sweep.pending.has(keyOf(root)))) return { state: 'starting' };
  return health;
}

/**
 * Starts (or resumes) syncing for one folder: clears a stale pidfile, then
 * `rig resume` — which also lifts a pause. Answers the state afterwards; a
 * failure is remembered so the Room and Home can say what went wrong.
 */
export async function startSync(root: string, deps: SyncHealthDeps = defaultDeps): Promise<Result<SyncHealth, { message: string }>> {
  const key = keyOf(root);
  if (starting.has(key)) return ok({ state: 'starting' });
  starting.add(key);
  announce(root);
  try {
    if ((await probeDaemon(root, deps)) === 'stale') {
      await rm(pidfileOf(root), { force: true }).catch(() => undefined);
    }
    const result = await toggleSync('resume', root);
    starting.delete(key);
    if (!result.success) {
      startErrors.set(key, result.error.message);
      return err(result.error);
    }
    const health = await readSyncHealth(root, deps);
    if (health.state === 'stopped') {
      const message = 'The sync process exited right after starting.';
      startErrors.set(key, message);
      return err({ message });
    }
    startErrors.delete(key);
    return ok(health);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startErrors.set(key, message);
    return err({ message });
  } finally {
    starting.delete(key);
    announce(root);
  }
}

/** The tapd script a daemon's command line runs, `…/tapd/dist/bin.js`. */
function tapdScriptOf(command: string): string | null {
  return /(\S*tapd\/dist\/bin\.js)/.exec(command)?.[1] ?? null;
}

/**
 * Stops this folder's daemon when it started before its own tapd script
 * was last replaced: an app or npm update since then, so it still runs the
 * old code and would keep doing so for days. The daemon writes its pidfile
 * as it starts, so that file's time is when it started. True when it was
 * stopped, for the sweep to start it again.
 */
export async function stopOutdatedDaemon(root: string, deps: SyncHealthDeps = defaultDeps): Promise<boolean> {
  if ((await probeDaemon(root, deps)) !== 'running') return false;
  const pid = await readPid(root);
  const command = pid === null ? null : await deps.commandOf(pid);
  const script = command ? tapdScriptOf(command) : null;
  if (pid === null || !script) return false;
  const mtime = deps.modifiedAt ?? modifiedAt;
  const [startedAt, scriptAt] = await Promise.all([mtime(pidfileOf(root)), mtime(script)]);
  if (startedAt === null || scriptAt === null || startedAt >= scriptAt) return false;
  (deps.stop ?? stopProcess)(pid);
  for (let waited = 0; waited < STOP_WAIT_MS && deps.isAlive(pid); waited += 100) await wait(100);
  log.info('rig: restarting a sync daemon left from before an update', { root });
  return true;
}

/** Whether the launch sweep should start this folder: there, bound, not paused, and no daemon of its own running. */
export async function shouldStartAtLaunch(root: string, deps: SyncHealthDeps = defaultDeps): Promise<boolean> {
  const health = await readSyncHealth(root, deps);
  return health.state === 'stopped' || health.state === 'error';
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The account's binding ids: the relay's list, else the one remembered on
 * this computer for it, else null. What decides which Rig-home folders are
 * the account's (`getLinkedPathsForAccount`); never throws.
 */
export async function getAccountBindingIds(accountId: string): Promise<Set<string> | null> {
  try {
    const live = await fetchWorkspaceBindings();
    if (live.success) return new Set(live.data.map((b) => b.id));
    const remembered = await readRememberedWorkspaces();
    if (remembered.accountId !== accountId || !remembered.workspaces) return null;
    return new Set(remembered.workspaces.bindings.map((b) => b.id));
  } catch (error) {
    log.warn('rig: could not list the account’s spaces', { error: String(error) });
    return null;
  }
}

/**
 * Launch: bring back sync for every rig the signed-in account has on this
 * computer. Best-effort throughout and never throws. An account that can't
 * be told yet (the relay unreachable right after a reboot) is asked again a
 * few times; signed out, nothing starts (sign-out paused them on purpose).
 * Every folder it will start is marked pending before any is started, and
 * the windows are told when the plan is made and as each start ends.
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
    const paths = await getLinkedPathsForAccount(account.id, await getAccountBindingIds(account.id));
    const toStart: string[] = [];
    for (const path of paths) {
      if ((await shouldStartAtLaunch(path, deps)) || (await stopOutdatedDaemon(path, deps))) toStart.push(path);
    }
    for (const path of toStart) sweep.pending.add(keyOf(path));
    sweep.planned = true;
    announce(null);
    for (const path of toStart) {
      try {
        const result = await startSync(path, deps);
        if (result.success) log.info('rig: started sync at launch', { path });
        else log.warn('rig: could not start sync at launch', { path, error: result.error.message });
      } finally {
        sweep.pending.delete(keyOf(path));
        announce(path);
      }
    }
  } catch (error) {
    log.warn('rig: launch sync sweep failed', { error: String(error) });
  } finally {
    // Skipped, or cut short by an error: whatever's left is no longer the sweep's.
    const leftover = !sweep.planned || sweep.pending.size > 0;
    sweep.planned = true;
    sweep.pending.clear();
    if (leftover) announce(null);
  }
}

export const rigSyncHealthController = createRPCController({
  /** Each folder's sync state on this computer, keyed by the path asked for. */
  get: async ({ paths }: { paths: string[] }): Promise<Record<string, SyncHealth>> => {
    const entries = await Promise.all(paths.map(async (path) => [path, await readShownSyncHealth(path)] as const));
    return Object.fromEntries(entries);
  },
  /** The Room/Home "Resume" / "Start syncing" / "Try again" button. */
  start: ({ path }: { path: string }) => startSync(path),
});
