/**
 * Which providers this app can honestly offer "Resume session" for
 * (`persistence-design.md` Round B).
 *
 * ACP's `loadSession` capability is a runtime fact — the connected agent
 * process reports it in its own `initialize` response
 * (`packages/runtime/src/acp-agents/connection/acp-agent-connection.ts`),
 * not something declared statically per provider anywhere in this repo. Of
 * the providers wired through `connectStdioAcp`, only two have their ACP
 * adapter *bundled* in this monorepo where `loadSession` can be verified
 * directly in source rather than trusted at face value:
 *
 *   - `claude` → `@agentclientprotocol/claude-agent-acp` — `initialize()`
 *     unconditionally returns `loadSession: true`, and `loadSession()` is a
 *     real implementation (`getOrCreateSession` + `replaySessionHistory`).
 *   - `codex` → `@agentclientprotocol/codex-acp` — same: `loadSession: true`
 *     advertised and implemented.
 *
 * Every other ACP-capable provider (`cursor`, `droid`, `qwen`, …) spawns the
 * user's own installed CLI binary in ACP mode — this repo has zero
 * visibility into whether *that* binary's version supports `session/load`.
 * "Unknown" is not "yes": per the brief, resume is only ever offered where
 * it is genuinely real, so this list stays exactly these two until another
 * adapter is bundled here and verified the same way.
 */
const RESUMABLE_PROVIDER_IDS: ReadonlySet<string> = new Set(['claude', 'codex']);

export function canResumeProvider(providerId: string): boolean {
  return RESUMABLE_PROVIDER_IDS.has(providerId);
}

/**
 * Whether a *specific stored session* can genuinely be resumed: the
 * provider must be resumable AND the runtime must have actually returned an
 * ACP session id for it (`rig_sessions.acp_session_id`) — a session created
 * before this existed, or one whose `startSession` never got far enough to
 * report one, has nothing for `loadSession` to resume from.
 */
export function canResumeSession(providerId: string, acpSessionId: string | null): boolean {
  return canResumeProvider(providerId) && acpSessionId !== null && acpSessionId.length > 0;
}
