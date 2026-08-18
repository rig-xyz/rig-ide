/**
 * Permission mode control — the deliberately-deferred `modeOptions`
 * dimension, now built as a genuine SAFETY control rather than a third
 * metadata dropdown. Pure decision logic only; the dropdown UI
 * (`permission-mode-picker.tsx`) is the one caller.
 *
 * Danger classification is investigated, not guessed — confirmed against
 * both bundled ACP adapters' real source:
 *
 *   - `@agentclientprotocol/claude-agent-acp` (`buildAvailableModes`)
 *     advertises `auto`, `default`, `acceptEdits`, `plan`, `dontAsk`, and
 *     (gated, not available running as root) `bypassPermissions` —
 *     "Bypass all permission checks." That last one is the only mode whose
 *     own description says no confirmation happens at all; every other
 *     mode still prompts, restricts, or denies rather than silently acting.
 *   - `@agentclientprotocol/codex-acp` (`AgentMode`) advertises exactly
 *     three: `read-only`, `agent` (the default), and `agent-full-access`
 *     — `approvalPolicy: "never"`, description "Codex can edit files
 *     outside this workspace and run commands with network access.
 *     Exercise caution when using." The adapter's own words already flag
 *     it as the dangerous one.
 *
 * So: exactly two known-dangerous ids across both adapters today. Any
 * OTHER id (an adapter this repo doesn't bundle, or a future mode neither
 * of these adds) is honestly unclassified — `isDangerousMode` returns
 * `false` for it rather than guessing, per the brief: "unknown modes = no
 * friction, they're the adapter's business."
 */
const DANGEROUS_MODE_IDS: ReadonlySet<string> = new Set(['bypassPermissions', 'agent-full-access']);

export function isDangerousMode(modeId: string): boolean {
  return DANGEROUS_MODE_IDS.has(modeId);
}

export type ModeSelectDecision =
  | { kind: 'apply'; modeId: string }
  | { kind: 'confirm'; modeId: string };

/**
 * What should happen when the user picks `pickedModeId` in the dropdown,
 * given `pendingConfirmId` (the id currently showing its inline "Confirm:
 * agent acts without asking" affordance, or null). Two-step only for an
 * escalation INTO a dangerous mode: the first pick on a dangerous id
 * arms the confirm row (`'confirm'`); a second pick on that SAME id
 * applies it (`'apply'`). Picking a DIFFERENT option while one is armed
 * — dangerous or not — re-arms/applies fresh rather than carrying the old
 * armed state over to a different option (never confirm the wrong mode
 * because of a stale prior click). De-escalating (any non-dangerous pick)
 * is always one click, unconditionally.
 */
export function decideModeSelect(pickedModeId: string, pendingConfirmId: string | null): ModeSelectDecision {
  if (!isDangerousMode(pickedModeId)) return { kind: 'apply', modeId: pickedModeId };
  if (pendingConfirmId === pickedModeId) return { kind: 'apply', modeId: pickedModeId };
  return { kind: 'confirm', modeId: pickedModeId };
}

/**
 * Round: permission-mode persistence — the every-session-resets rule was
 * deliberate for a SAFETY control, but it reset everything, model/effort
 * included, which was never the intent. Revised: a picked mode becomes a
 * remembered "usual preference" for this harness (`RigChatStore.setMode`,
 * same `lastModelByHarness`/`lastEffortByHarness` shape) UNLESS it's a
 * dangerous one — picking `bypassPermissions`/`agent-full-access` never
 * writes anything, so a session can never silently inherit "acts without
 * asking" from a past pick. A persisted SAFE mode still only auto-applies
 * once, same as model/effort; a session with nothing safe persisted starts
 * at the adapter's own default, unchanged from today.
 */
export function shouldPersistMode(modeId: string): boolean {
  return !isDangerousMode(modeId);
}
