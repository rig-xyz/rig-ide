import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { events, rpc } from '@renderer/lib/ipc';
import { rigAgentSignInNeededChannel } from '@shared/rig/agents-status';
import { agentNeedsSignIn, cliLoginMethod } from './agent-auth-state';
import { afterAgentSignIn, agentAuthQuery } from './use-agent-auth-probe';

const SIGN_IN_NEEDED_KEY = ['rig', 'agent-sign-in-needed'] as const;

/**
 * Whether this agent needs its owner to sign in again on this Mac
 * (`agentNeedsSignIn`), with what the Sign in action needs: the agent's
 * payload and CLI login method for `AgentSignInDialog`, and `markSignedIn`
 * for its success. Reads the same probe query as Settings' rows, and main's
 * record of a run that failed on its sign-in, kept fresh by
 * `rigAgentSignInNeededChannel`.
 */
export function useAgentSignInNeeded(agentId: 'claude' | 'codex') {
  const queryClient = useQueryClient();
  const { data: agents } = useRunnableAgents();
  const agent = agents?.find((a) => a.id === agentId && a.status === 'available') ?? null;
  const loginMethod = useMemo(() => (agent ? cliLoginMethod(agent.capabilities) : null), [agent]);

  const probe = useQuery(agentAuthQuery(agentId, loginMethod !== null));
  const recorded = useQuery({
    queryKey: SIGN_IN_NEEDED_KEY,
    queryFn: () => rpc.rig.agentSignIn.needed(),
    staleTime: Infinity,
  });
  useEffect(
    () => events.on(rigAgentSignInNeededChannel, ({ agents: needed }) => queryClient.setQueryData(SIGN_IN_NEEDED_KEY, needed)),
    [queryClient]
  );

  const needed = agentNeedsSignIn({
    runnable: agent !== null,
    loginMethod,
    probeData: probe.data,
    failedOnSignIn: recorded.data?.includes(agentId) ?? false,
  });

  const markSignedIn = useCallback(() => afterAgentSignIn(queryClient, agentId), [queryClient, agentId]);

  return { needed, agent, loginMethod, markSignedIn };
}
