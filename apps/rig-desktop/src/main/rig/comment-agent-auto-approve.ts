import type {
  RigCommentPermissionDetail,
  RigCommentPermissionOption,
  RigCommentPermissionRequest,
} from '@shared/rig/comments';

/**
 * Two independent auto-approve paths for a headless comment-agent turn's
 * pending permission requests, both applied in `comment-agent.ts`'s
 * `publishPermissions` before anything reaches the thread card:
 *
 * 1. `partitionAutoApprovable` — always on, and scoped to exactly one shape:
 *    the read-only `rig context` CLI lookup that `comment-agent-prompt.ts`'s
 *    hidden context tells Claude and Codex to run whenever a reviewer asks
 *    "why is this here?" (see `formatRigContextHiddenContext` in
 *    `@shared/rig/context`). Codex's sandbox auto-runs workspace commands, so
 *    this never surfaces there. Claude's ACP provider relays every tool
 *    permission through `comment-agent.ts`'s `followPermissions`/
 *    `publishPermissions`, which posts an Allow/Reject card — including an
 *    "Always allow all Bash" option and the raw command line — straight into
 *    the comment thread. For this one lookup that is a UX defect, not a
 *    safeguard: it is a read against Rig/Tap's own provenance data, by design
 *    safe, and a non-technical reader has no way to evaluate a base64 target
 *    string.
 *
 * 2. `partitionGloballyApprovable` — gated on the "Auto-approve agent
 *    actions" app setting (off by default, `settings-modal.tsx`'s Agents
 *    section), applied to everything the first path left visible. When the
 *    reader has turned it on, no permission card is ever shown for a
 *    comment-thread agent — every request grants immediately.
 */

/**
 * The read-only subcommands under `rig context`, mirrored from the CLI's
 * actual dispatch (`rig-doc-context` `src/context.mjs` `contextDispatch`,
 * lines 895-920): only `trace` and `read` exist, and both are pure reads —
 * there is no write subcommand under `context` today. If one is ever added,
 * it must not be added to this set without a matching write-safety review.
 */
const READ_ONLY_CONTEXT_SUBCOMMANDS = new Set(['trace', 'read']);

/**
 * Characters that could chain a second command onto the one being inspected:
 * `;`, `&` (including `&&`), `|` (including `||`), a `>` redirect, a
 * backtick, a newline or carriage return (a newline separates commands
 * exactly like `;` does), or `<` (which also covers `<(…)` process
 * substitution — an argument like `--target <(cmd)` would execute `cmd`).
 * Checked as a blunt substring/character test rather than by parsing shell
 * grammar — deliberately conservative, since a benign command this rejects
 * still falls through to the ordinary permission prompt, while a chained
 * command this let through would run unattended.
 */
const CHAINING_METACHARACTERS = /[;&|`><\n\r]/;

/** `$(...)` command substitution — not caught by `CHAINING_METACHARACTERS`. */
const COMMAND_SUBSTITUTION = '$(';

function hasChainingRisk(command: string): boolean {
  return CHAINING_METACHARACTERS.test(command) || command.includes(COMMAND_SUBSTITUTION);
}

/** Strips one matching layer of `'...'` or `"..."` quoting, if present. */
function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) return token.slice(1, -1);
  }
  return token;
}

/** Last path segment, tolerant of both `/` and `\` separators. */
function basenameOf(token: string): string {
  const segments = token.split(/[/\\]/);
  return segments[segments.length - 1] || token;
}

/**
 * True when `token` is the exact rig-executable reference the comment-agent
 * hidden context prompt hands the model — the literal `"$RIG_CLI_PATH"` env
 * reference (quoted or not) — or a path (quoted or not) whose final segment
 * is literally `rig`. A bare `rig` found on some other PATH still matches:
 * the safety property this predicate is checking is the command shape
 * (read-only `context` subcommand, no chaining), not which `rig` binary runs.
 */
function isRigCliToken(token: string): boolean {
  if (token === '"$RIG_CLI_PATH"' || token === '$RIG_CLI_PATH') return true;
  return basenameOf(unquote(token)) === 'rig';
}

/**
 * True when `command` is exactly a read-only `rig context` lookup: the rig
 * executable, `context`, and a subcommand from the read-only set above, with
 * no shell metacharacters that could chain a second command onto it.
 *
 * Extra flags and arguments after the subcommand (`--target <ref> --json`)
 * are accepted — once chaining is ruled out they cannot do anything but
 * change what the read-only lookup returns. Anything else about the shape —
 * a different binary, a different subcommand, or the faintest hint of
 * chaining — is treated as not matching, which leaves it for the ordinary
 * permission prompt exactly as before this predicate existed.
 */
export function isReadOnlyContextCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (trimmed.length === 0 || hasChainingRisk(trimmed)) return false;

  const [binary, subject, subcommand] = trimmed.split(/\s+/);
  if (!binary || !isRigCliToken(binary)) return false;
  if (subject !== 'context') return false;
  return subcommand !== undefined && READ_ONLY_CONTEXT_SUBCOMMANDS.has(subcommand);
}

function isExecuteDetail(
  detail: RigCommentPermissionDetail | undefined
): detail is RigCommentPermissionDetail & { kind: 'execute' } {
  return detail?.kind === 'execute';
}

/**
 * The permission option that grants this one call without touching the
 * session's standing policy. Only `allow_once` qualifies: `allow_always`
 * opts the whole session out of future prompts for the same tool, which is a
 * broader grant than "this one read-only lookup is safe to skip asking
 * about" — a request offering only `allow_always` is left for a human.
 */
function allowOnceOptionId(options: readonly RigCommentPermissionOption[]): string | null {
  return options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
}

/**
 * The option id to resolve `request` with immediately, without publishing it
 * to the thread — or null when a human must decide, exactly as today.
 */
export function autoApproveOptionId(request: RigCommentPermissionRequest): string | null {
  if (!isExecuteDetail(request.detail) || !isReadOnlyContextCommand(request.detail.command)) {
    return null;
  }
  return allowOnceOptionId(request.options);
}

/**
 * Splits one batch of pending requests into the ones a human must still see
 * and the ones an `approveOptionId` predicate resolved on the spot, calling
 * `resolve` once per newly auto-approved request. `alreadyResolved` guards
 * against resolving the same request twice: the session's `pendingPermissions`
 * state can re-emit an auto-approved request before its resolution
 * round-trip has removed it, and a request pending resolution must stay off
 * the published list either way. Shared by both auto-approve paths below —
 * the read-only `rig context` predicate and the global setting's
 * approve-everything one — so "skip resolving a request twice" and "leave it
 * visible when there's no plain option to grant" are written, and tested,
 * exactly once.
 */
function partitionWithApprover(
  requests: readonly RigCommentPermissionRequest[],
  alreadyResolved: Set<string>,
  resolve: (requestId: string, optionId: string) => void,
  approveOptionId: (request: RigCommentPermissionRequest) => string | null
): RigCommentPermissionRequest[] {
  const visible: RigCommentPermissionRequest[] = [];
  for (const request of requests) {
    if (alreadyResolved.has(request.requestId)) continue;
    const optionId = approveOptionId(request);
    if (optionId) {
      alreadyResolved.add(request.requestId);
      resolve(request.requestId, optionId);
      continue;
    }
    visible.push(request);
  }
  return visible;
}

/**
 * Splits one batch of pending requests into the ones a human must still see
 * and the ones just auto-approved, calling `resolve` once per newly
 * auto-approved request. `alreadyResolved` guards against resolving the same
 * request twice: the session's `pendingPermissions` state can re-emit an
 * auto-approved request before its resolution round-trip has removed it, and
 * a request pending resolution must stay off the published list either way.
 */
export function partitionAutoApprovable(
  requests: readonly RigCommentPermissionRequest[],
  alreadyResolved: Set<string>,
  resolve: (requestId: string, optionId: string) => void
): RigCommentPermissionRequest[] {
  return partitionWithApprover(requests, alreadyResolved, resolve, autoApproveOptionId);
}

/**
 * The global "Auto-approve agent actions" setting (Settings → Agents) applied
 * to whatever `partitionAutoApprovable` left visible: every one of those
 * requests is resolved immediately via its own `allow_once` option — never
 * `allow_always`, for the same reason `autoApproveOptionId` above never picks
 * it — and none of them reach the thread card. Unlike the read-only-context
 * predicate, there is no per-request shape check: the setting itself is the
 * human's standing consent, made once in Settings rather than per tool call.
 * A request that offers no `allow_once` at all (only `allow_always`, say) is
 * left visible rather than granted through the broader option — the same
 * restraint `autoApproveOptionId` applies, and the point of the "never
 * `allow_always`" rule everywhere in this module.
 */
export function partitionGloballyApprovable(
  requests: readonly RigCommentPermissionRequest[],
  alreadyResolved: Set<string>,
  resolve: (requestId: string, optionId: string) => void
): RigCommentPermissionRequest[] {
  return partitionWithApprover(requests, alreadyResolved, resolve, (request) =>
    allowOnceOptionId(request.options)
  );
}
