/**
 * Plain-language reasons for an agent session that couldn't start, shared by
 * every surface that shows one (the chat panel, a space's Room). The runtime
 * returns tagged errors (`spawn_failed`, `new_session_failed`, ...) whose
 * cause carries the underlying message; the tag alone ("new_session_failed")
 * tells people nothing.
 */

type StartErrorLike = {
  type?: unknown;
  message?: unknown;
  cause?: { name?: unknown; message?: unknown } | null;
};

/** Messages that say nothing beyond "it failed" — the tag's own phrase reads better. */
const GENERIC_MESSAGES = new Set(['', 'Internal error', 'Unknown error']);

/**
 * Maps an OS-level spawn failure (surfaced as text, e.g. "spawn Unknown
 * system error -86" or "spawn /usr/local/bin/claude EACCES") to a sentence
 * people can act on. Returns null when the text isn't one of these.
 */
export function describeSpawnFailure(text: string, agentName?: string): string | null {
  const installed = `the installed ${agentName ?? 'agent'}`;
  // -86 is EBADARCH on macOS (Node doesn't name it): "Bad CPU type in executable".
  if (/EBADARCH|ENOEXEC|Bad CPU type|Exec format error|system error -86\b/i.test(text)) {
    return `This Mac can't run ${installed}: it's built for a different processor. Reinstall it, then try again.`;
  }
  // Only spawn failures: a missing or unreadable *file* the agent itself
  // touches (ENOENT/EACCES on open) is not the CLI being missing.
  if (/\bspawn\b.*\bEACCES\b/.test(text)) {
    return `This Mac isn't allowed to run ${installed} (permission denied). Reinstall it, then try again.`;
  }
  if (/\bspawn\b.*\bENOENT\b/.test(text)) {
    return `Rig couldn't find ${agentName ?? 'the agent'} where it expected it. Reinstall it, then try again.`;
  }
  return null;
}

function phraseForType(type: string, agentName: string): string {
  switch (type) {
    case 'auth_required':
      return `${agentName} needs you to sign in`;
    case 'spawn_failed':
      return `${agentName}'s program couldn't be launched`;
    case 'initialize_failed':
      return `${agentName} didn't finish starting up`;
    case 'new_session_failed':
      return `${agentName} couldn't open a session`;
    default:
      return type || 'Unknown error';
  }
}

/**
 * The reason an agent session couldn't start, in words: a known cause (CLI
 * built for another processor, missing, not executable) gets its own
 * sentence; otherwise the underlying message, or a phrase for the error kind
 * when that message is empty or generic.
 */
export function describeAgentStartError(error: unknown, agentName?: string): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as StartErrorLike;
  const type = typeof value.type === 'string' ? value.type : '';
  const causeMessage = typeof value.cause?.message === 'string' ? value.cause.message : '';
  const raw = (typeof value.message === 'string' && value.message) || causeMessage;

  // Already a plain-language reason written for people (see CliUnrunnableError).
  if (value.cause?.name === 'cli-unrunnable' && causeMessage) return causeMessage;

  const spawn = describeSpawnFailure(raw, agentName);
  if (spawn) return spawn;
  return GENERIC_MESSAGES.has(raw.trim()) ? phraseForType(type, agentName ?? 'The agent') : raw;
}
