/**
 * Pure helpers for offering an agent: which install commands to show, and
 * whether it has a sign-in of its own. They outlived the round-H2 wizard,
 * which the first run (`features/first-run`) replaced; `agent-install.tsx`
 * and the first run's Set up step use them. Side-effect free, so they're
 * tested without mocking any RPC.
 *
 * `preferredInstallOptions` is ported from `apps/emdash-desktop`'s
 * `features/onboarding/agent-step-state.ts` (read-only reference).
 */

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
