import type { AgentAuthStatus } from '@emdash/core/agents/plugins';

/**
 * Which agent the catch-up runs on. The orchestrator reaches it over ACP, so
 * Set up is built around "your agent" through the plugin capabilities, and
 * this is the one place that picks Claude: it is the only agent the
 * orchestrator routes to today. Routing another one is this entry plus how
 * it reaches the person's connectors.
 */
export const ROUTED_AGENT_ID = 'claude';

export type AgentRoute = {
  id: string;
  /** The agent as the copy names it: "Sign in with Claude". */
  brand: string;
  /** "Does the work through your Claude." */
  yours: string;
  /** What the person signs in with: "your Claude account". */
  account: string;
  /** Where its connectors live: "claude.ai". */
  connectorsHome: string;
  /** Whether a signed-in status can reach the person's connectors. */
  reachesConnectors: (auth: Extract<AgentAuthStatus, { kind: 'authenticated' }>) => boolean;
};

const ROUTES: Record<string, AgentRoute> = {
  claude: {
    id: 'claude',
    brand: 'Claude',
    yours: 'your Claude',
    account: 'Claude account',
    connectorsHome: 'claude.ai',
    // A key runs sessions but has no claude.ai connectors. A login the CLI
    // doesn't describe (`unknown`, an older CLI) gets the benefit of the doubt.
    reachesConnectors: (auth) => auth.method !== 'api-key',
  },
};

export function agentRoute(id: string = ROUTED_AGENT_ID): AgentRoute {
  return (
    ROUTES[id] ?? {
      id,
      brand: id,
      yours: 'your agent',
      account: 'account',
      connectorsHome: id,
      reachesConnectors: () => true,
    }
  );
}
