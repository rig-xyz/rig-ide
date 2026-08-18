import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  rigSlug,
  validateRigName,
  type RigCreateError,
  type RigCreateRequest,
  type RigCreateResult,
  type RigCreateSyncError,
} from '@shared/rig/create';
import { commandFailureMessage } from './auth-output';
import { resolveCliBin } from './bundled-cli';

/**
 * Creates a rig by driving the bundled CLI headlessly — the same
 * spawn/timeout/parse conventions as `join.ts`'s `rig join` driver:
 *
 *   1. mkdir <parentDir>/<slug>  (the folder's basename IS the rig name —
 *      `rig init` has no --name flag; `createDefaultManifest` slugs the
 *      basename, and `rigSlug` is a fixpoint of that rule)
 *   2. `rig init --json [--sync]` in that folder. Under --json even THROWN
 *      CLI errors (the dangerous-location guard, rig.toml collisions) come
 *      back as a parseable `{error: {code, message}}` envelope on stdout
 *      (see rig's own `bin/rig.mjs` catch) — surfaced verbatim.
 *   3. when sync is on: `rig sync --json` — the CLI's real go-live verb
 *      (`ensureLive` → tapd init mints the relay binding + mirrors to the
 *      user's workspace home, then starts the sync daemon). Its failure
 *      (not signed in, the relay's 50MB `quota_exceeded`, unreachable) is a
 *      PARTIAL success: the rig exists on disk, so the result carries the
 *      sync error rather than pretending the whole creation failed.
 */

const INIT_TIMEOUT_MS = 20_000;
/** Binds, mirrors the initial content to the relay, and starts the daemon — join.ts's generous headroom. */
const SYNC_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_CHARS = 64 * 1024;

// ── CLI output parsing (pure, exported for direct unit testing) ──────────────

export type ParsedCliOutput =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'unparseable' };

/**
 * Parses one `--json` invocation's stdout: the LAST line that parses as a
 * JSON object wins (interactive-mode noise or stray warnings never poison
 * the read), and an `error` envelope — `{ error: { code, message } }`, how
 * `bin/rig.mjs` reports even thrown errors under --json — becomes the
 * error case with the CLI's own message intact.
 */
export function parseRigCliOutput(stdout: string): ParsedCliOutput {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const body = parsed as Record<string, unknown>;
    const errorRaw = body.error;
    if (typeof errorRaw === 'object' && errorRaw !== null) {
      const envelope = errorRaw as Record<string, unknown>;
      return {
        kind: 'error',
        code: typeof envelope.code === 'string' ? envelope.code : 'error',
        message:
          typeof envelope.message === 'string' && envelope.message
            ? envelope.message
            : 'The rig CLI reported an error.',
      };
    }
    return { kind: 'ok', body };
  }
  return { kind: 'unparseable' };
}

// ── CLI driver ───────────────────────────────────────────────────────────────

type SpawnOutcome =
  | { kind: 'ran'; exitCode: number | null; stdout: string; stderr: string }
  | { kind: 'spawnFailed'; bin: string }
  | { kind: 'timedOut' };

function runRig(args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
  const bin = resolveCliBin();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (value: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      settle({ kind: 'timedOut' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
    });

    child.on('error', (error) => {
      log.warn('Rig create: could not run the rig CLI', { bin, args: args[0], error: String(error) });
      settle({ kind: 'spawnFailed', bin });
    });

    child.on('close', (exitCode) => {
      settle({ kind: 'ran', exitCode, stdout, stderr });
    });
  });
}

/**
 * The one `rig sync` driver (loose-ends round: extracted so the unsynced-rig
 * interstitial and the create dialog's "Turn on sync" reuse it rather than
 * duplicating the spawn/parse/verdict) — runs `rig sync --json` in `dir` and
 * reduces every outcome to synced-or-why-not, with the CLI's own message
 * carried verbatim (not_logged_in, the relay's 50MB quota, …).
 */
export async function enableSyncInDir(
  dir: string
): Promise<Result<{ homeUrl: string | null }, RigCreateSyncError>> {
  const live = await runRig(['sync', '--json'], dir, SYNC_TIMEOUT_MS);
  if (live.kind === 'spawnFailed') {
    return err<RigCreateSyncError>({
      code: 'cli_missing',
      message: `Could not run \`${live.bin}\` to enable sync.`,
    });
  }
  if (live.kind === 'timedOut') {
    return err<RigCreateSyncError>({
      code: 'timeout',
      message: 'Enabling sync timed out — run `rig sync` in the folder to retry.',
    });
  }
  const parsed = parseRigCliOutput(live.stdout);
  if (parsed.kind === 'error') {
    return err<RigCreateSyncError>({ code: parsed.code, message: parsed.message });
  }
  if (parsed.kind === 'unparseable' || live.exitCode !== 0) {
    return err<RigCreateSyncError>({
      code: 'error',
      message: commandFailureMessage('sync', `${live.stdout}\n${live.stderr}`, live.exitCode),
    });
  }
  if (parsed.body.state !== 'live') {
    return err<RigCreateSyncError>({
      code: 'error',
      message: 'Sync did not come on — run `rig sync` in the folder to retry.',
    });
  }
  const workspace =
    typeof parsed.body.workspace === 'object' && parsed.body.workspace !== null
      ? (parsed.body.workspace as Record<string, unknown>)
      : null;
  return ok({ homeUrl: typeof workspace?.homeUrl === 'string' ? workspace.homeUrl : null });
}

// ── controller ───────────────────────────────────────────────────────────────

export const rigCreateController = createRPCController({
  create: async ({
    parentDir,
    name,
    sync,
  }: RigCreateRequest): Promise<Result<RigCreateResult, RigCreateError>> => {
    const invalid = validateRigName(name);
    if (invalid) return err<RigCreateError>({ kind: 'invalidName', message: invalid });
    const slug = rigSlug(name);
    const targetDir = joinPath(parentDir, slug);

    if (existsSync(targetDir)) {
      return err<RigCreateError>({
        kind: 'exists',
        message: `A folder named “${slug}” already exists there.`,
      });
    }
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (error) {
      return err<RigCreateError>({
        kind: 'initFailed',
        message: `Could not create the folder: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const init = await runRig(['init', '--json', ...(sync ? ['--sync'] : [])], targetDir, INIT_TIMEOUT_MS);
    const initError = interpretInitFailure(init);
    if (initError) {
      // Best-effort: never leave an empty husk behind for a failed init.
      // Non-recursive on purpose — if init wrote anything, the folder stays.
      try {
        rmdirSync(targetDir);
      } catch {
        // not empty or already gone — leave it
      }
      return err(initError);
    }

    const initBody = init.kind === 'ran' ? parseRigCliOutput(init.stdout) : null;
    const rigName =
      initBody?.kind === 'ok' && typeof initBody.body.name === 'string' ? initBody.body.name : slug;

    if (!sync) {
      return ok({ path: targetDir, rigName, synced: false, homeUrl: null, syncError: null });
    }

    // Go live. Every failure from here is PARTIAL: the rig exists on disk.
    const live = await enableSyncInDir(targetDir);
    if (!live.success) {
      return ok({ path: targetDir, rigName, synced: false, homeUrl: null, syncError: live.error });
    }
    return ok({
      path: targetDir,
      rigName,
      synced: true,
      homeUrl: live.data.homeUrl,
      syncError: null,
    });
  },

  /**
   * Turns sync on for an EXISTING local-only rig — the unsynced-rig
   * interstitial's and the create dialog's "Turn on sync" action. Same
   * driver as creation's own sync step (`enableSyncInDir`); the caller
   * re-runs `workspace.detect` afterwards, which now finds the binding.
   */
  enableSync: async ({
    dir,
  }: {
    dir: string;
  }): Promise<Result<{ homeUrl: string | null }, RigCreateSyncError>> => {
    return enableSyncInDir(dir);
  },
});

/** Init failures end the creation (nothing usable exists yet) — map each spawn outcome to the typed error. */
function interpretInitFailure(outcome: SpawnOutcome): RigCreateError | null {
  if (outcome.kind === 'spawnFailed') {
    return {
      kind: 'cliMissing',
      message: `Could not run \`${outcome.bin}\`. Install the rig CLI (npm i -g @rigxyz/cli) and try again.`,
    };
  }
  if (outcome.kind === 'timedOut') {
    return { kind: 'initFailed', message: 'Creating the rig timed out.' };
  }
  const parsed = parseRigCliOutput(outcome.stdout);
  if (parsed.kind === 'error') {
    // The CLI's own message, verbatim — this is where the dangerous-location
    // guard ("Refusing to run rig init in …") surfaces.
    return { kind: 'initFailed', message: parsed.message, code: parsed.code };
  }
  if (parsed.kind === 'unparseable' || outcome.exitCode !== 0) {
    return {
      kind: 'initFailed',
      message: commandFailureMessage('init', `${outcome.stdout}\n${outcome.stderr}`, outcome.exitCode),
    };
  }
  return null;
}
