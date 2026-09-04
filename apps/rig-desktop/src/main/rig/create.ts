import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
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
import { rigFileRootRegistry } from './file-root-registry';
import { ensureRigHomeDir, resolveHomeLandingDir } from './home';

/**
 * Creates a rig by driving the bundled CLI headlessly — the same
 * spawn/timeout/parse conventions as `join.ts`'s `rig join` driver:
 *
 *   1. mkdir <parentDir>/<slug>, or `<home>/<slug>` (collision-suffixed)
 *      when `parentDir` is omitted — the default, name-only flow (rig home
 *      round; `parentDir` is now only the "Advanced: choose location…"
 *      escape hatch). The folder's basename IS the rig name — `rig init`
 *      has no --name flag; `createDefaultManifest` slugs the basename, and
 *      `rigSlug` is a fixpoint of that rule.
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

export type SpawnOutcome =
  | { kind: 'ran'; exitCode: number | null; stdout: string; stderr: string }
  | { kind: 'spawnFailed'; bin: string }
  | { kind: 'timedOut' };

// Exported: `rig-controls.ts` (`rig move`/`rig pause`/`rig resume`) reuses
// this same spawn/timeout plumbing rather than a second copy.
export function runRig(args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
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
      log.warn('Rig create: could not run the rig CLI', {
        bin,
        args: args[0],
        error: String(error),
      });
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

// ── seed doc (onboarding flow round) ──────────────────────────────────────────

const START_HERE_FILENAME = 'Start here.md';

/**
 * The seeded first document's content (docs/onboarding-flow-spec.md §3,
 * "Landing: a doc, not an empty state") — three lines that are each a real
 * action on a real surface, not a generic empty state. Exported for direct
 * unit testing.
 */
export function startHereDocContent(): string {
  return [
    '# Welcome to your rig',
    '',
    'Select any sentence and leave a comment.',
    '',
    'Mention **@claude** or **@codex** in a comment to bring an agent in.',
    '',
    "When you're ready, **Share** to invite your team.",
    '',
  ].join('\n');
}

/**
 * Writes the landing doc into a freshly created rig, before it opens.
 * Best-effort, same rule the optional Google-Doc import already follows
 * (`create-rig-dialog.tsx`): a write failure never fails creation itself —
 * the rig is real either way, it would just open with no starter doc.
 */
export async function writeSeedDoc(targetDir: string): Promise<string | null> {
  const docPath = joinPath(targetDir, START_HERE_FILENAME);
  try {
    await writeFile(docPath, startHereDocContent(), 'utf8');
    return docPath;
  } catch (error) {
    log.warn('Rig create: could not write the seed doc', { error: String(error) });
    return null;
  }
}

// ── controller ───────────────────────────────────────────────────────────────

async function withRegisteredRoot(
  result: Omit<RigCreateResult, 'rootId'>
): Promise<RigCreateResult> {
  const registered = await rigFileRootRegistry.register(result.path);
  if (!registered.success) {
    log.warn('Rig create: could not issue the temporary import root', {
      kind: registered.error.kind,
    });
  }
  return { ...result, rootId: registered.success ? registered.data.rootId : null };
}

export const rigCreateController = createRPCController({
  create: async ({
    parentDir,
    name,
    sync,
    seedDoc,
  }: RigCreateRequest): Promise<Result<RigCreateResult, RigCreateError>> => {
    const invalid = validateRigName(name);
    if (invalid) return err<RigCreateError>({ kind: 'invalidName', message: invalid });
    const slug = rigSlug(name);
    // `parentDir` null/omitted is the default flow (rig home round): name
    // only, landing in `<home>/<slug>` — collision-suffixed, same rule the
    // CLI's own `rig join`/`rig attach` land by. A caller-picked `parentDir`
    // (the "Advanced: choose location…" escape hatch) still nests the rig
    // as `<parentDir>/<slug>`, unchanged from before.
    const targetDir = parentDir
      ? joinPath(parentDir, slug)
      : resolveHomeLandingDir(await ensureRigHomeDir(), slug);

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

    const init = await runRig(
      ['init', '--json', ...(sync ? ['--sync'] : [])],
      targetDir,
      INIT_TIMEOUT_MS
    );
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

    telemetryService.capture('rig_created', {});
    const initBody = init.kind === 'ran' ? parseRigCliOutput(init.stdout) : null;
    const rigName =
      initBody?.kind === 'ok' && typeof initBody.body.name === 'string' ? initBody.body.name : slug;

    // Seeded before any sync attempt, so a first `rig sync` mirrors it too.
    const docPath = seedDoc ? await writeSeedDoc(targetDir) : null;

    if (!sync) {
      return ok(
        await withRegisteredRoot({
          path: targetDir,
          rigName,
          synced: false,
          homeUrl: null,
          syncError: null,
          docPath,
        })
      );
    }

    // Go live. Every failure from here is PARTIAL: the rig exists on disk.
    const live = await enableSyncInDir(targetDir);
    if (!live.success) {
      return ok(
        await withRegisteredRoot({
          path: targetDir,
          rigName,
          synced: false,
          homeUrl: null,
          syncError: live.error,
          docPath,
        })
      );
    }
    return ok(
      await withRegisteredRoot({
        path: targetDir,
        rigName,
        synced: true,
        homeUrl: live.data.homeUrl,
        syncError: null,
        docPath,
      })
    );
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
      message: commandFailureMessage(
        'init',
        `${outcome.stdout}\n${outcome.stderr}`,
        outcome.exitCode
      ),
    };
  }
  return null;
}
