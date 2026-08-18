/**
 * Pure state for the first-run onboarding wizard (round H2). Kept
 * side-effect free so the step-flow decision is testable without mocking
 * any RPC — the components (`onboarding.tsx`, `agents-step.tsx`,
 * `sign-in-step.tsx`) just feed real query data through these.
 *
 * `hasInstalledAgent`/`onboardingAgents`/`preferredInstallOptions` are
 * ported near-verbatim from `apps/emdash-desktop`'s
 * `features/onboarding/agent-step-state.ts` (read-only reference) — same
 * logic, generalized off that app's `AgentPayload` to this app's shape.
 */

export type OnboardingStep = 'agents' | 'signIn';

/**
 * Which steps the wizard shows, in order. `[]` means don't show onboarding
 * at all. Agents is unconditional whenever onboarding shows at all (round
 * H2's explicit call, a deliberate departure from emdash's own AgentStep:
 * "AGENTS FIRST... skippable, honestly" — the step itself is never hidden,
 * only ever skippable from inside it); sign-in drops out entirely when
 * already signed in — no redundant "you're already signed in, click
 * Continue" screen. This is also exactly why the step dots (`if
 * steps.length < 2`) matter: a returning-ish signed-in-but-fresh-install
 * user genuinely sees a ONE-step wizard.
 */
export function deriveOnboardingSteps(state: {
  hasSeenOnboarding: boolean;
  signedIn: boolean;
}): OnboardingStep[] {
  if (state.hasSeenOnboarding) return [];
  return state.signedIn ? ['agents'] : ['agents', 'signIn'];
}

/** The agents step's completion condition: at least one agent is actually installed — never gated on sign-in, an API-key env var is equally valid and invisible from here. */
export function hasInstalledAgent(agents: readonly { status: string }[] | undefined): boolean {
  return (agents ?? []).some((agent) => agent.status === 'available');
}

/** The two agents with real resume support (round H2's explicit choice) — narrowed to only when neither is found, since a step offering nothing is worse than a longer list. */
export const RECOMMENDED_AGENT_IDS: ReadonlySet<string> = new Set(['claude', 'codex']);

export function onboardingAgents<T extends { id: string; name: string }>(
  agents: readonly T[] | undefined,
  recommendedIds: ReadonlySet<string> = RECOMMENDED_AGENT_IDS
): T[] {
  const all = [...(agents ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const recommended = all.filter((agent) => recommendedIds.has(agent.id));
  return recommended.length > 0 ? recommended : all;
}

/** The install commands to show for one agent — narrows to the recommended method(s) when the plugin names any, else shows everything the platform offers. */
export function preferredInstallOptions<T extends { recommended?: boolean }>(
  options: readonly T[]
): T[] {
  const recommended = options.filter((option) => option.recommended);
  return recommended.length > 0 ? recommended : [...options];
}

/**
 * Whether an installed agent has its own CLI sign-in flow — the "sign in
 * to {agent}" offer's gate. Round H2 scopes this offer to a static
 * informational line (see `agents-step.tsx`), not emdash's embedded-xterm
 * sign-in modal: driving an agent's `cli-login` command headlessly would
 * need new main-process spawn/URL-scrape infrastructure (a real, buildable
 * mirror of `main/rig/auth.ts`'s `rig login` driver, just not built this
 * round) — a deliberate, reported scope cut, not a shortcut taken quietly.
 */
export function hasCliLogin(capabilities: { auth: { kind: string } }): boolean {
  return capabilities.auth.kind === 'supported';
}
