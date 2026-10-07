import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { rpc } from '@renderer/lib/ipc';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { cliLoginMethod, deriveAgentAuthRowState } from './agent-auth-state';

/** The one auth-status query per agent, shared by every row and warning that reads it. */
export function agentAuthQuery(agentId: string, enabled: boolean) {
  return {
    queryKey: ['rig', 'agent-auth', agentId] as const,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const client = await getAgentConfigRuntimeClient();
      const result = await client.refreshAuthStatus({ providerId: agentId });
      return result.success ? result.data : null;
    },
  };
}

/** After the sign-in dialog succeeds: main forgets the run that failed on its sign-in, and the probe runs again. */
export function afterAgentSignIn(queryClient: QueryClient, agentId: string): void {
  void rpc.rig.agentSignIn.signedIn(agentId as 'claude' | 'codex').catch(() => {});
  void queryClient.invalidateQueries({ queryKey: agentAuthQuery(agentId, true).queryKey });
}

/**
 * Probes one installed agent's CLI auth status via the already-running
 * agent-config runtime process (`refreshAuthStatus` — the runtime itself
 * caches this for 15 minutes, see `AgentAuthManager`; this hook adds its
 * own `staleTime` on top only to avoid a redundant round-trip on every row
 * remount within that window). Disabled entirely when the agent has no
 * CLI-login method — `deriveAgentAuthRowState` also short-circuits on that,
 * so the query never even needs to be enabled to reach the right answer,
 * but skipping the call outright avoids a wasted IPC round-trip.
 */
export function useAgentAuthProbe(agent: AgentPayload) {
  const queryClient = useQueryClient();
  const [signedInOverride, setSignedInOverride] = useState(false);
  const loginMethod = useMemo(() => cliLoginMethod(agent.capabilities), [agent.capabilities]);

  const query = useQuery(agentAuthQuery(agent.id, loginMethod !== null));

  const state = deriveAgentAuthRowState({
    loginMethod,
    signedInOverride,
    probeStatus: query.status,
    probeData: query.data,
  });

  /** Called by the sign-in dialog on success: flips the row immediately, then re-probes for the real account label. */
  const markSignedIn = useCallback(() => {
    setSignedInOverride(true);
    afterAgentSignIn(queryClient, agent.id);
  }, [queryClient, agent.id]);

  return { loginMethod, state, markSignedIn };
}
