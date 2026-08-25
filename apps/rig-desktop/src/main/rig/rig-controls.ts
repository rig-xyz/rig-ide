import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { commandFailureMessage } from './auth-output';
import { runRig, type SpawnOutcome } from './create';
import { extractJsonObjects, parseJsonErrorEnvelope } from './join';
import { updateRigPath } from './recent-rigs';
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

export const rigControlController = createRPCController({
  /** rigs-rail row menu's "Move to Rig folder" (only offered for a row whose path is outside home). */
  move: ({ bindingId, path }: { bindingId: string; path: string }) => moveRig(bindingId, path),
  /** rigs-rail row menu's "Pause syncing". */
  pause: ({ path }: { path: string }) => toggleSync('pause', path),
  /** rigs-rail row menu's "Resume syncing". */
  resume: ({ path }: { path: string }) => toggleSync('resume', path),
});
