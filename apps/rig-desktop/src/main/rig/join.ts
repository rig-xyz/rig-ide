import { spawn } from 'node:child_process';
import { app } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigAttachError, RigJoinResult, RigLocateError } from '@shared/rig/join';
import { commandFailureMessage } from './auth-output';
import { findBindingConfig } from './binding';
import { resolveCliBin } from './bundled-cli';

/**
 * Self-service local setup for a relay-only binding the signed-in user is a
 * MEMBER of — round H2's Home screen "Set up locally" action, generalized
 * (round: rig attach) to every role. See `shared/rig/join.ts`'s header
 * comment for the full history of why this couldn't work for editor/viewer
 * bindings before the CLI shipped `rig attach`.
 *
 * One step now, not two: drive the bundled `rig attach <bindingId> --dir
 * <targetDir> --json` — it mints its own device credential straight off the
 * relay's member-gated endpoint, so there's no invite to self-mint from
 * here first. Spawned and parsed the same way `main/rig/auth.ts` drives
 * `rig login`.
 */

/** `rig attach` mints a device, clones the manifest, and starts the sync daemon — generous headroom over a plain relay call. */
const ATTACH_TIMEOUT_MS = 60_000;
const OUTPUT_MAX_CHARS = 64 * 1024;

/**
 * C4 fix: `resolveCliBin` is bundled-first in a PACKAGED build — it never
 * consults the user's own PATH/npm-installed `rig` at all, so "run npm i -g
 * @rigxyz/cli" is advice that literally cannot fix anything there (the
 * outdated CLI a packaged build hits is its OWN bundled copy, vendored at
 * build time — see `scripts/vendor-rig-cli.ts`'s `RIG_CLI_VERSION`; the
 * only real fix is updating the app itself). Only a DEV build's
 * `resolveCliBin` fallback (bare `'rig'`, OS-PATH-resolved) is ever the
 * developer's own global install, where the npm command is genuinely
 * actionable.
 */
function outdatedCliMessage(): string {
  return app.isPackaged
    ? 'This version of Rig needs an update to set up rigs this way.'
    : 'Setting up rigs from the app needs a newer rig CLI. Update with: npm i -g @rigxyz/cli';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Every top-level, balanced `{...}` JSON object found in `output`, in
 * order — tolerant of stray non-JSON text anywhere around or between them
 * (an npm warning, a shell startup banner a very old CLI build might still
 * leak to stdout). Correctly handles BOTH of the CLI's own `--json` output
 * shapes: `bin/rig.mjs`'s error envelope is compact single-line
 * (`JSON.stringify({...})`), but `collab.mjs`'s success payloads (`rig
 * attach --json` among them) are pretty-printed MULTI-LINE
 * (`JSON.stringify({...}, null, 2)`) — a per-LINE scan (what this used to
 * be, and what `create.ts`'s `parseRigCliOutput` still is) can never match
 * those at all, stray lines or not. Tracks string-literal boundaries (with
 * escape handling) so a brace inside a quoted message — `"Unexpected token
 * }"` — never miscounts as structural.
 */
function extractJsonObjects(output: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        const candidate = output.slice(start, i + 1);
        start = -1;
        try {
          const record = asRecord(JSON.parse(candidate));
          if (record) objects.push(record);
        } catch {
          // Balanced braces but not actually valid JSON (shouldn't happen
          // given the string-tracking above, but never worth throwing over).
        }
      }
    }
  }
  return objects;
}

/**
 * The CLI's `--json` error envelope: `{ protocolVersion, error: { code,
 * message } }`. Scans `output`'s JSON objects from the LAST backward for
 * one that actually has that shape — tolerant of an unrelated earlier (or
 * later) JSON blob that isn't the envelope.
 */
function parseJsonErrorEnvelope(output: string): { code: string; message: string } | null {
  const objects = extractJsonObjects(output);
  for (let i = objects.length - 1; i >= 0; i--) {
    const error = asRecord(objects[i].error);
    if (error && typeof error.message === 'string') {
      return { code: typeof error.code === 'string' ? error.code : 'error', message: error.message };
    }
  }
  return null;
}

/** An installed CLI that predates `attach` rejects it via `cli.mjs`'s generic `default:` branch — this is that exact message, matched precisely so a genuinely broken `attach` invocation is never misreported as "just update." */
const UNKNOWN_ATTACH_COMMAND = /Unknown command "attach"/i;

/**
 * Classifies a failed `rig attach --json` run into one of `RigAttachError`'s
 * kinds. Pure — takes the child process's captured output and exit code,
 * nothing else — so the "old CLI" and typed-envelope cases are each their
 * own tested unit rather than buried in the spawn callback.
 */
export function classifyAttachFailure(stdout: string, stderr: string, code: number | null): RigAttachError {
  // Try the JSON envelope first — its `message` is unescaped by `JSON.parse`,
  // so the "Unknown command" check below must run against IT rather than the
  // raw output (which carries the JSON string's own backslash-escaped
  // quotes, e.g. `\"attach\"`, and would never match a plain-quote regex).
  const envelope = parseJsonErrorEnvelope(stdout) ?? parseJsonErrorEnvelope(stderr);
  if (envelope) {
    if (UNKNOWN_ATTACH_COMMAND.test(envelope.message)) {
      return { kind: 'outdatedCli', message: outdatedCliMessage() };
    }
    if (envelope.code === 'not_logged_in') return { kind: 'notSignedIn', message: envelope.message };
    if (envelope.code === 'not_a_member') return { kind: 'notAMember', message: envelope.message };
    return { kind: 'attachFailed', message: envelope.message };
  }

  // No JSON envelope at all — an even older CLI that predates `--json`
  // error routing entirely, printing plain text to stderr instead.
  const combined = `${stdout}\n${stderr}`;
  if (UNKNOWN_ATTACH_COMMAND.test(combined)) {
    return { kind: 'outdatedCli', message: outdatedCliMessage() };
  }
  return { kind: 'attachFailed', message: commandFailureMessage('attach', combined, code) };
}

/**
 * Parses `rig attach --json`'s success envelope — the `dir`/`rigName`/
 * `syncing` fields, the same shape `rig join --json` already produces (see
 * `shared/rig/join.ts`). Takes the LAST JSON object in `stdout` (via
 * `extractJsonObjects`) rather than requiring the whole trimmed stdout to
 * be exactly one JSON document — a fix for a real bug: this payload is
 * pretty-printed multi-line, and a single stray line anywhere in stdout
 * (an npm warning, a shell banner) used to fail `JSON.parse` outright,
 * reporting a genuinely successful attach as "output could not be read."
 * Returns `null` only when stdout has no JSON object in it at all.
 */
export function parseAttachSuccess(stdout: string, fallbackDir: string): RigJoinResult | null {
  const parsed = extractJsonObjects(stdout).at(-1);
  if (!parsed) return null;
  const localPath = typeof parsed.dir === 'string' ? parsed.dir : fallbackDir;
  const rigName = typeof parsed.rigName === 'string' ? parsed.rigName : null;
  const syncing = parsed.syncing === true;
  return { localPath, rigName, syncing };
}

/** Drives `rig attach <bindingId> --dir <targetDir> --json` — spawn, parse, done. `--json` pins the CLI's non-interactive branch, same as `--plain` does for `rig login`. */
function spawnAttach(bindingId: string, targetDir: string): Promise<Result<RigJoinResult, RigAttachError>> {
  const bin = resolveCliBin();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (value: Result<RigJoinResult, RigAttachError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(bin, ['attach', bindingId, '--dir', targetDir, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      settle(err<RigAttachError>({ kind: 'attachFailed', message: 'Setting up the rig locally timed out.' }));
    }, ATTACH_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-OUTPUT_MAX_CHARS);
    });

    child.on('error', (error) => {
      log.warn('Rig attach: could not run the rig CLI', { bin, error: String(error) });
      settle(
        err<RigAttachError>({
          kind: 'cliMissing',
          message: `Could not run \`${bin}\`. Install the rig CLI (npm i -g @rigxyz/cli) and try again.`,
        })
      );
    });

    child.on('close', (code) => {
      if (code !== 0) {
        settle(err(classifyAttachFailure(stdout, stderr, code)));
        return;
      }
      const result = parseAttachSuccess(stdout, targetDir);
      if (!result) {
        log.warn('Rig attach: could not parse `rig attach --json` output');
        settle(
          err<RigAttachError>({
            kind: 'attachFailed',
            message: 'rig attach finished, but its output could not be read.',
          })
        );
        return;
      }
      settle(ok(result));
    });
  });
}

// ── locate (correction round — replaces the deleted filesystem scan) ───────
//
// "I already have this rig on my machine, I just haven't told this app
// where" — the honest, user-consented alternative to a background scan:
// the user themselves picks ONE directory (a real native dialog, never
// enumerated), and this verifies it's genuinely the right one before
// anything gets recorded.

export type LocateOutcome =
  | { kind: 'matched'; localPath: string }
  | { kind: 'notFound' }
  | { kind: 'mismatch'; foundBindingId: string };

/**
 * Pure — the decision only, no filesystem access. `found` is whatever
 * `findBindingConfig` (walks up from the picked directory, the identical
 * rule `resolveCommentTarget`/the CLI itself use) turned up, or null.
 */
export function deriveLocateOutcome(
  expectedBindingId: string,
  found: { bindingId: string; workspaceRoot: string } | null
): LocateOutcome {
  if (!found) return { kind: 'notFound' };
  if (found.bindingId !== expectedBindingId) return { kind: 'mismatch', foundBindingId: found.bindingId };
  return { kind: 'matched', localPath: found.workspaceRoot };
}

export const rigJoinController = createRPCController({
  /**
   * Drives `rig attach` for `bindingId` into `targetDir` — works for any
   * explicit member (owner/editor/viewer), unlike the old self-minted-invite
   * flow this replaced. The caller (the Home screen's "Download" action, and
   * the invites bell's post-accept "Set up locally") opens the resulting
   * `localPath` via the normal `openPath` flow — this RPC only sets the
   * folder up, it never opens anything itself.
   */
  attach: async ({
    bindingId,
    targetDir,
  }: {
    bindingId: string;
    targetDir: string;
  }): Promise<Result<RigJoinResult, RigAttachError>> => {
    return spawnAttach(bindingId, targetDir);
  },

  /**
   * "Locate…" — verifies a user-picked directory is genuinely this
   * binding, without recording anything itself. The caller (the Home
   * screen) opens the resulting `localPath` via the normal `openPath` flow
   * on success, which is what actually upserts `rig_rigs` — the same path
   * every other "open a folder" entry point in this app already goes
   * through, so this binding is "picked up" the identical, proven way.
   */
  locate: async ({
    bindingId,
    dir,
  }: {
    bindingId: string;
    dir: string;
  }): Promise<Result<{ localPath: string }, RigLocateError>> => {
    const location = findBindingConfig(dir);
    const outcome = deriveLocateOutcome(
      bindingId,
      location ? { bindingId: location.config.bindingId, workspaceRoot: location.workspaceRoot } : null
    );
    if (outcome.kind === 'notFound') {
      return err<RigLocateError>({
        kind: 'notFound',
        message: "No rig found there — pick the rig's own folder (or a folder inside it).",
      });
    }
    if (outcome.kind === 'mismatch') {
      return err<RigLocateError>({
        kind: 'mismatch',
        message: "That folder is a different rig, not this one.",
      });
    }
    return ok({ localPath: outcome.localPath });
  },
});
