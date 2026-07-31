import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigAuthError, RigAuthStatus, RigLoginStarted } from '@shared/rig/auth';
import { extractRigAuthUrl, loginFailureMessage, logoutFailureMessage } from './auth-output';
import { bundledRigBinDir } from './bundled-cli';
import { readRelayToken } from './config';

/**
 * Signing in to Rig by driving the bundled `rig login`.
 *
 * With stdio piped the CLI takes its non-interactive branch: it prints the hub
 * auth URL, runs its OWN loopback callback server, and on success writes the
 * relay PAT to `~/.config/rig/config.json` before exiting 0. So the app opens
 * one URL and waits — there is no embedded browser session here, and the PAT
 * never passes through this process.
 *
 * `--plain` pins the non-interactive branch even if stdio were ever inherited.
 */

/** The CLI gives up after 5 minutes; this is only a backstop around that. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 + 30_000;
/** How long to wait for the auth URL before deciding the CLI won't print one. */
const URL_TIMEOUT_MS = 30_000;
/** Cap on retained CLI output — only the tail is ever used for messages. */
const OUTPUT_MAX_CHARS = 64 * 1024;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type LoginSession = {
  child: ChildProcess;
  started: Promise<Result<RigLoginStarted, RigAuthError>>;
  done: Promise<Result<void, RigAuthError>>;
  settled: boolean;
  cancelled: boolean;
};

let session: LoginSession | null = null;

/**
 * The `rig` to run: the bundled shim in packaged builds, otherwise whatever is
 * on PATH (dev builds have no bundled CLI). A missing `rig` surfaces as a
 * `cliMissing` error when the spawn fails, so the UI can say so.
 */
function resolveRigBin(): string {
  const binDir = bundledRigBinDir();
  if (binDir) {
    const shim = join(binDir, 'rig');
    if (existsSync(shim)) return shim;
  }
  return 'rig';
}

function startLogin(): LoginSession {
  const bin = resolveRigBin();
  const startedDeferred = deferred<Result<RigLoginStarted, RigAuthError>>();
  const doneDeferred = deferred<Result<void, RigAuthError>>();

  let output = '';
  let startedSettled = false;

  const child = spawn(bin, ['login', '--plain'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const current: LoginSession = {
    child,
    started: startedDeferred.promise,
    done: doneDeferred.promise,
    settled: false,
    cancelled: false,
  };

  const settleStarted = (value: Result<RigLoginStarted, RigAuthError>) => {
    if (startedSettled) return;
    startedSettled = true;
    clearTimeout(urlTimer);
    startedDeferred.resolve(value);
  };

  const settleDone = (value: Result<void, RigAuthError>) => {
    if (current.settled) return;
    current.settled = true;
    clearTimeout(loginTimer);
    // A failure before the URL was seen has to unblock `login()` too.
    settleStarted(value.success ? ok({ url: null }) : err(value.error));
    doneDeferred.resolve(value);
  };

  const kill = () => {
    if (!child.killed) child.kill();
  };

  // Declared after the settle helpers that clear them; both are only ever read
  // from callbacks, which cannot run before this point.
  const loginTimer = setTimeout(() => {
    kill();
    settleDone(
      err<RigAuthError>({
        kind: 'timeout',
        message: 'Sign-in timed out. Try again, or run `rig login` in a terminal.',
      })
    );
  }, LOGIN_TIMEOUT_MS);

  const urlTimer = setTimeout(() => {
    kill();
    settleDone(
      err<RigAuthError>({
        kind: 'failed',
        message: 'rig login did not print a sign-in link. Try running `rig login` in a terminal.',
      })
    );
  }, URL_TIMEOUT_MS);

  const onChunk = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
    if (startedSettled) return;
    const url = extractRigAuthUrl(output);
    if (url) settleStarted(ok({ url }));
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('error', (error) => {
    log.warn('Rig auth: could not run the rig CLI', { bin, error: String(error) });
    settleDone(
      err<RigAuthError>({
        kind: 'cliMissing',
        message: `Could not run \`${bin}\`. Install the rig CLI (npm i -g @rigxyz/cli) and try again.`,
      })
    );
  });

  child.on('close', (code) => {
    if (current.cancelled) {
      settleDone(err<RigAuthError>({ kind: 'cancelled', message: 'Sign-in was cancelled.' }));
      return;
    }
    // Exit 0 without a URL means the CLI was already signed in — still success.
    if (code === 0) {
      settleDone(ok(undefined));
      return;
    }
    settleDone(err<RigAuthError>({ kind: 'failed', message: loginFailureMessage(output, code) }));
  });

  return current;
}

/** Stops an in-flight login — used both by the explicit `cancel` RPC and by `logout`. */
function cancelInFlightLogin(): void {
  if (!session || session.settled) return;
  session.cancelled = true;
  if (!session.child.killed) session.child.kill();
}

/**
 * Drives `rig logout --plain`, which calls the CLI's own `clearHubToken()` —
 * the app never deletes `~/.config/rig/config.json` itself, so it never has
 * its own opinion about what "signed out" means. A non-zero exit or a missing
 * CLI resolves as an error, never a silent success.
 */
function runLogout(): Promise<Result<void, RigAuthError>> {
  const bin = resolveRigBin();
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const settle = (value: Result<void, RigAuthError>) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawn(bin, ['logout', '--plain'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const onChunk = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (error) => {
      log.warn('Rig auth: could not run the rig CLI', { bin, error: String(error) });
      settle(
        err<RigAuthError>({
          kind: 'cliMissing',
          message: `Could not run \`${bin}\`. Install the rig CLI (npm i -g @rigxyz/cli) and try again.`,
        })
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        settle(ok(undefined));
        return;
      }
      settle(err<RigAuthError>({ kind: 'failed', message: logoutFailureMessage(output, code) }));
    });
  });
}

/**
 * Every method returns a Result (or a plain status) and never throws across the
 * IPC boundary.
 */
export const rigAuthController = createRPCController({
  /** Whether a relay PAT is already on disk. Re-read every call — see `config.ts`. */
  status: async (): Promise<RigAuthStatus> => ({ signedIn: (await readRelayToken()) !== null }),

  /**
   * Starts `rig login` and resolves as soon as the sign-in URL is known — the
   * process keeps running until the user finishes in the browser. Call
   * `awaitLogin` for the outcome. Re-entrant: a second call while a login is in
   * flight returns the same URL rather than starting a rival callback server.
   */
  login: async (): Promise<Result<RigLoginStarted, RigAuthError>> => {
    if (!session || session.settled) session = startLogin();
    return session.started;
  },

  /** Resolves when the in-flight `rig login` finishes (ok) or fails. */
  awaitLogin: async (): Promise<Result<void, RigAuthError>> => {
    if (!session) {
      return err<RigAuthError>({ kind: 'failed', message: 'No sign-in is in progress.' });
    }
    return session.done;
  },

  /** Stops an in-flight login — the user skipped the step or left it. */
  cancel: async (): Promise<void> => {
    cancelInFlightLogin();
  },

  /**
   * Signs out machine-wide via `rig logout --plain`. Cancels any in-flight
   * login first so signing out never leaves an orphan child process behind.
   */
  logout: async (): Promise<Result<void, RigAuthError>> => {
    cancelInFlightLogin();
    return runLogout();
  },
});
