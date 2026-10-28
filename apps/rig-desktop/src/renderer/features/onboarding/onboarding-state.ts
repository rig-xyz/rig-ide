/**
 * Pure state for the onboarding wizard (round H2), the one a new install
 * sees with Rig Alpha off (with it on, the first run, `features/first-run`,
 * replaces it). Kept side-effect free so the step-flow decision is
 * testable without mocking any RPC — the components (`onboarding.tsx`, `agents-step.tsx`,
 * `sign-in-step.tsx`) just feed real query data through these. The first
 * run's Set up step and `agent-install.tsx` use the install helpers too.
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

/**
 * The install commands to show for one agent. Ways that need a program this
 * Mac lacks (npm with no Node) drop out while another way is left; of the
 * rest, the recommended ones when the plugin names any, else all of them.
 */
export function preferredInstallOptions<T extends { recommended?: boolean; missingTool?: string }>(
  options: readonly T[]
): T[] {
  const usable = options.filter((option) => !option.missingTool);
  const pool = usable.length > 0 ? usable : [...options];
  const recommended = pool.filter((option) => option.recommended);
  return recommended.length > 0 ? recommended : pool;
}

/**
 * Whether an installed agent has its own CLI sign-in flow. When it does,
 * `AgentSignInDialog` (`features/agents/agent-sign-in-dialog.tsx`) runs that
 * login (`claude auth login` for Claude) in an embedded terminal, from
 * Settings › Agents, the agents' warnings and the first run's Set up step.
 */
export function hasCliLogin(capabilities: { auth: { kind: string } }): boolean {
  return capabilities.auth.kind === 'supported';
}
