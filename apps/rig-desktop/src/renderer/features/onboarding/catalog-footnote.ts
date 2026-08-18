/**
 * The Agents step only ever shows a couple of rows — installed agents, or a
 * guided-install card for one or two recommended ones (`onboardingAgents`'s
 * narrowing). Dylan's concern: someone whose harness isn't among those (e.g.
 * Pi) has no signal the registry supports it at all, and can reasonably
 * conclude rig doesn't. A muted card below the list communicates catalog
 * breadth without a new grid — a few real icons (rendered by
 * `agents-step.tsx` from `useAgentIdentities`, keyed by these same ids),
 * plus a real count of the rest.
 *
 * The count is NEVER hardcoded: it's the actual registry size (from
 * `rpc.agents.listMetadata()`, the same instant, unprobed source
 * `useAgentIdentities` already reads elsewhere) minus however many are shown
 * as icons — so the number tracks the plugin registry as it grows, rather
 * than quietly going stale the next time an agent is added.
 */
export const CATALOG_FOOTNOTE_AGENT_IDS = ['amp', 'pi', 'opencode'] as const;

export function deriveCatalogFootnote(totalAgentCount: number): string {
  const others = Math.max(0, totalAgentCount - CATALOG_FOOTNOTE_AGENT_IDS.length);
  const noun = others === 1 ? 'agent' : 'agents';
  const verb = others === 1 ? 'is' : 'are';
  return `and ${others} more ${noun} ${verb} detected automatically once installed.`;
}
