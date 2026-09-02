import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { commandFailureMessage } from './auth-output';
import { runRig, type SpawnOutcome } from './create';
import { extractJsonObjects, parseJsonErrorEnvelope } from './join';
import { existsAsDirectory, getRigPathsForAccount, updateRigName, updateRigPath } from './recent-rigs';
import { setTomlRigName } from './rig-toml';
import { isRigSyncPaused } from './sync-paused';

/**
 * Drives `rig move` and `rig pause`/`rig resume` — the rigs-rail row
 * menu's "Move to Rig folder" and sync pause/resume toggle
 * (docs/rig-home-design.md, "New abilities"). Same spawn/timeout/parse
 * conventions as `join.ts`/`create.ts`.
 *
 * `rig move --json` gets a real success envelope (`{from, to, daemon}`) —
 * `rig pause`/`rig resume` don't (`collabStop`/`collabStart` never check
 * `flags.json` for their success output, only thrown errors go through the
 * `--json` envelope via `bin/rig.mjs`'s top-level catch). So pause/resume
 * verify what actually happened by re-reading `.rig/sync-paused.json`
 * afterward — the same file the CLI itself persists and `tapd start`
 * gates on — rather than trusting exit code alone.
 */

const MOVE_TIMEOUT_MS = 20_000;
const SYNC_TOGGLE_TIMEOUT_MS = 15_000;

/** Maps a failed spawn to a one-line message — the envelope's own message when there is one, else the exit output's last line. */
function spawnFailureMessage(command: string, outcome: Extract<SpawnOutcome, { kind: 'ran' }>): string {
  const envelope = parseJsonErrorEnvelope(outcome.stdout) ?? parseJsonErrorEnvelope(outcome.stderr);
  if (envelope) return envelope.message;
  return commandFailureMessage(command, `${outcome.stdout}\n${outcome.stderr}`, outcome.exitCode);
}

function spawnOutcomeToMessage(command: string, outcome: SpawnOutcome): { message: string } | null {
  if (outcome.kind === 'spawnFailed') {
    return { message: `Could not run \`${outcome.bin}\`. Install the rig CLI (npm i -g @rigxyz/cli) and try again.` };
  }
  if (outcome.kind === 'timedOut') {
    return { message: `rig ${command} timed out.` };
  }
  if (outcome.exitCode !== 0) {
    return { message: spawnFailureMessage(command, outcome) };
  }
  return null;
}

/**
 * `rig move <path> --json` — relocates a rig into (or within) the managed
 * home. `path` is passed as the absolute positional target, so the spawn's
 * own cwd is irrelevant (`collabMove` resolves a relative positional
 * against ITS `process.cwd()`, but an absolute path resolves to itself
 * regardless). On success, updates `rig_rigs.path` for `bindingId` so the
 * rail reflects the new location without a full refetch depending on the
 * CLI's own next-open bookkeeping.
 */
export async function moveRig(
  bindingId: string,
  path: string
): Promise<Result<{ path: string }, { message: string }>> {
  const outcome = await runRig(['move', path, '--json'], path, MOVE_TIMEOUT_MS);
  const failure = spawnOutcomeToMessage('move', outcome);
  if (failure) return err(failure);
  // outcome.kind === 'ran' && exitCode === 0 here (spawnOutcomeToMessage
  // returned null) — narrow for the parse below.
  const ran = outcome as Extract<SpawnOutcome, { kind: 'ran' }>;
  const parsed = extractJsonObjects(ran.stdout).at(-1);
  const newPath = parsed && typeof parsed.to === 'string' ? parsed.to : null;
  if (!newPath) {
    return err({ message: 'rig move finished, but its output could not be read.' });
  }
  await updateRigPath(bindingId, newPath);
  return ok({ path: newPath });
}

/** `rig pause`/`rig resume` in `path` (spawn `cwd`, not `--dir` — `rig pause` accepts no `--dir` at all, only reads `process.cwd()`). Returns the verified paused state afterward, read straight off `.rig/sync-paused.json`. */
async function toggleSync(
  verb: 'pause' | 'resume',
  path: string
): Promise<Result<{ paused: boolean }, { message: string }>> {
  const outcome = await runRig([verb, '--json'], path, SYNC_TOGGLE_TIMEOUT_MS);
  const failure = spawnOutcomeToMessage(verb, outcome);
  if (failure) return err(failure);
  return ok({ paused: await isRigSyncPaused(path) });
}

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs") —
 * `auth.ts`'s logout (pause) and login (resume) hooks: every local rig
 * `getRigPathsForAccount` has on record for `accountId`, toggled the same
 * way the row menu's own pause/resume does. Idempotent (pausing an
 * already-paused rig, or resuming an already-running one, is just what
 * `rig pause`/`rig resume` already do) and best-effort throughout — a rig
 * folder that's since been deleted or moved is skipped and logged, and
 * ANY failure here (a bad spawn, a missing CLI, a lookup error) is caught
 * and logged rather than thrown, so it can never fail the logout/login
 * this rides along with.
 */
async function togglePathsForAccount(verb: 'pause' | 'resume', accountId: string): Promise<void> {
  let paths: string[];
  try {
    paths = await getRigPathsForAccount(accountId);
  } catch (error) {
    log.warn(`rig: failed to look up rigs to ${verb} for the signed-out/in account`, {
      error: String(error),
    });
    return;
  }
  for (const path of paths) {
    try {
      if (!(await existsAsDirectory(path))) {
        log.info(`rig: skipping ${verb} — rig folder no longer exists`, { path });
        continue;
      }
      const result = await toggleSync(verb, path);
      if (!result.success) {
        log.warn(`rig: failed to ${verb} rig`, { path, error: result.error.message });
      }
    } catch (error) {
      log.warn(`rig: failed to ${verb} rig`, { path, error: String(error) });
    }
  }
}

/** `auth.ts`'s logout hook: pause every local rig recorded for `accountId`. */
export function pauseRigsForAccount(accountId: string): Promise<void> {
  return togglePathsForAccount('pause', accountId);
}

/** `auth.ts`'s login hook: resume every local rig recorded for `accountId`. */
export function resumeRigsForAccount(accountId: string): Promise<void> {
  return togglePathsForAccount('resume', accountId);
}

/**
 * rigs-rail row menu's "Rename…". Rewrites `rig.toml`'s `[rig].name` field
 * in place (`setTomlRigName` — a targeted line edit, not a parse/
 * re-serialize; see that module's own header comment for why) and mirrors
 * the new name into `rig_rigs.name` so the rail's next render reflects it
 * without waiting on the file-watcher round trip.
 *
 * `rig.toml` is itself a tapd-synced file, so this write propagates to
 * every other member on its own the moment tapd picks it up — no relay
 * call needed for that half.
 *
 * TODO(rig CLI / relay): there is no `rig rename` CLI subcommand and no
 * relay "rename binding" endpoint today (`PATCH /v1/me/bindings/:id` only
 * accepts `{org, visibility}` — checked against `tap`'s own
 * `packages/relay/src/routes/account.ts`), so the binding's OWN name on the
 * relay (as opposed to the `rig.toml` this app and the CLI actually read
 * display names from) stays whatever it was minted with. Wire a relay PATCH
 * once one exists, if that divergence ever becomes a real problem.
 */
export async function renameRig(
  bindingId: string,
  path: string,
  newName: string
): Promise<Result<{ name: string }, { message: string }>> {
  const trimmed = newName.trim();
  if (!trimmed) return err({ message: 'Name cannot be empty.' });

  const tomlPath = join(path, 'rig.toml');
  let raw: string;
  try {
    raw = await readFile(tomlPath, 'utf8');
  } catch (error) {
    return err({ message: `Could not read rig.toml: ${error instanceof Error ? error.message : String(error)}` });
  }

  const rewritten = setTomlRigName(raw, trimmed);
  if (rewritten === null) {
    return err({ message: 'Could not find a [rig] name field in rig.toml.' });
  }

  try {
    await writeFile(tomlPath, rewritten, 'utf8');
  } catch (error) {
    return err({ message: `Could not save rig.toml: ${error instanceof Error ? error.message : String(error)}` });
  }

  await updateRigName(bindingId, trimmed);
  return ok({ name: trimmed });
}

export const rigControlController = createRPCController({
  /** rigs-rail row menu's "Move to Rig folder" (only offered for a row whose path is outside home). */
  move: ({ bindingId, path }: { bindingId: string; path: string }) => moveRig(bindingId, path),
  /** rigs-rail row menu's "Pause syncing". */
  pause: ({ path }: { path: string }) => toggleSync('pause', path),
  /** rigs-rail row menu's "Resume syncing". */
  resume: ({ path }: { path: string }) => toggleSync('resume', path),
  /** rigs-rail row menu's "Rename…". */
  rename: ({ bindingId, path, name }: { bindingId: string; path: string; name: string }) =>
    renameRig(bindingId, path, name),
});
