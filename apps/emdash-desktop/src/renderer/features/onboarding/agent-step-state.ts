import type { AgentAuthMethod } from '@emdash/core/agents/plugins';
import type {
  AgentCapabilities,
  AgentPayload,
  InstallOption,
} from '@shared/core/agents/agent-payload';

export type CliLoginMethod = Extract<AgentAuthMethod, { kind: 'cli-login' }>;

/**
 * Which agents onboarding offers. A first run should present a short, opinionated
 * list rather than the settings page's full catalogue, so this narrows to the
 * same recommended set — but falls back to everything available if a build ships
 * without any of them, since a step offering nothing is worse than a long list.
 */
export function onboardingAgents(
  agents: AgentPayload[] | undefined,
  recommendedIds: ReadonlySet<string>
): AgentPayload[] {
  const all = [...(agents ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const recommended = all.filter((agent) => recommendedIds.has(agent.id));
  return recommended.length > 0 ? recommended : all;
}

/** The step's completion condition: at least one agent is actually installed. */
export function hasInstalledAgent(agents: AgentPayload[] | undefined): boolean {
  return (agents ?? []).some((agent) => agent.status === 'available');
}

/**
 * The install commands to show. Narrows to the plugin's recommended method when
 * it names one, so the step shows a single obvious command instead of every
 * package manager the agent supports.
 */
export function preferredInstallOptions(options: InstallOption[]): InstallOption[] {
  const recommended = options.filter((option) => option.recommended);
  return recommended.length > 0 ? recommended : options;
}

/**
 * The agent's `rig`-driveable browser/CLI sign-in method, if it has one. Agents
 * authenticated by an API-key env var have none — which is why sign-in can never
 * be a hard requirement for finishing the step.
 */
export function cliLoginMethod(capabilities: AgentCapabilities): CliLoginMethod | null {
  if (capabilities.auth.kind !== 'supported') return null;
  const method = capabilities.auth.methods.find((candidate) => candidate.kind === 'cli-login');
  return method ?? null;
}
