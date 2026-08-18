import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { cliLoginMethod, deriveAgentAuthRowState } from './agent-auth-state';

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
  const queryKey = useMemo(() => ['rig', 'agent-auth', agent.id] as const, [agent.id]);

  const query = useQuery({
    queryKey,
    enabled: loginMethod !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const client = await getAgentConfigRuntimeClient();
      const result = await client.refreshAuthStatus({ providerId: agent.id });
      return result.success ? result.data : null;
    },
  });

  const state = deriveAgentAuthRowState({
    loginMethod,
    signedInOverride,
    probeStatus: query.status,
    probeData: query.data,
  });

  /** Called by the sign-in dialog on success: flips the row immediately, then re-probes for the real account label. */
  const markSignedIn = useCallback(() => {
    setSignedInOverride(true);
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return { loginMethod, state, markSignedIn };
}
