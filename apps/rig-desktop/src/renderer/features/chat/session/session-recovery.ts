/**
 * Pure helpers behind `rig-chat-store.ts`'s dead-session recovery.
 *
 * Bug: a failed turn in Claude "Plan Mode" (or any turn whose failure kills
 * the adapter's underlying SDK query without the agent PROCESS itself
 * exiting) left the session unusable — every later send/mode change failed
 * identically, with only a repeating toast. Investigation
 * (packages/runtime/src/acp-agents — see `cell.ts`'s `sendPromptInternal`,
 * `machine.ts`'s `TurnEnded`/`ProcessClosed`, and the bundled
 * `@agentclientprotocol/claude-agent-acp` adapter's `session.queryClosed`
 * guard) found the runtime's own session machine returns to `phase: 'ready'`
 * after ANY settled turn, including an errored one — so a cell that reports
 * itself healthy (`canSubmit: true`) can still have every real RPC into the
 * agent process fail, because the adapter's OWN per-session query died
 * without the process exiting (so `SessionManager.onProcessClosed` — the
 * one thing that would otherwise mark the record dead — never fires). A
 * *single* `prompt_failed`/`set_mode_failed`/`set_config_failed` is just an
 * ordinary turn/config failure (rate limit, refusal, a bad model pick, …)
 * and must not trigger a reconnect on its own; TWO of that shape in a row,
 * with nothing that succeeded in between, is the actual signal a dead
 * session leaves behind (see `rig-chat-store.ts`'s `_suspectSessionDead`).
 */

const SESSION_FAILURE_ERROR_TYPES = new Set([
  'prompt_failed',
  'set_mode_failed',
  'set_config_failed',
]);

/**
 * Whether an `AcpRuntimeError`-shaped failure (`{ type, message?, cause? }`,
 * from `@emdash/core/acp`'s `acpErr`) is one of the three RPCs a dead
 * session's stale record forwards straight into the adapter — as opposed to
 * e.g. `conversation_not_found` (the runtime already knows the session is
 * gone, no recovery needed) or `invalid_state` (a client-side ordering bug,
 * not an adapter failure).
 */
export function isSessionFailureError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const type = (error as { type?: unknown }).type;
  return typeof type === 'string' && SESSION_FAILURE_ERROR_TYPES.has(type);
}

/**
 * A human-readable message from a thrown `Error` or a `BaseError`-shaped
 * runtime error (`{ message?, cause?: { message } }`), truncated to one
 * line — for the toast/inline banner, which have no room for a stack trace
 * or a multi-paragraph adapter error.
 */
export function extractErrorMessage(error: unknown, maxLength = 160): string | undefined {
  const raw = rawErrorMessage(error);
  if (!raw) return undefined;
  const oneLine = raw.split('\n')[0]?.trim();
  if (!oneLine) return undefined;
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function rawErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { message?: unknown; cause?: { message?: unknown } };
  if (typeof candidate.message === 'string' && candidate.message) return candidate.message;
  if (typeof candidate.cause?.message === 'string' && candidate.cause.message) {
    return candidate.cause.message;
  }
  return undefined;
}
