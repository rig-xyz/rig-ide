import { CircleAlert } from 'lucide-react';
import { AgentSignInButton } from '@renderer/features/agents/agent-sign-in-button';
import { useAgentSignInNeeded } from '@renderer/features/agents/use-agent-sign-in-needed';
import type { AgentKind } from '../types';
import { AGENT_NAME } from './identity';

/**
 * One of your agents needs you to sign in again on this Mac
 * (`useAgentSignInNeeded`): a warning row in the space panel's Agents
 * section, same 28px row grammar, with the Sign in Settings uses. Renders
 * nothing otherwise. Kept out of `agent-rows.tsx`, which renders without the
 * app (fixtures, the scripted demo): the Room passes it in.
 */
export function AgentSignInRow({ agent }: { agent: AgentKind }) {
  const { needed, agent: payload, loginMethod, markSignedIn } = useAgentSignInNeeded(agent);
  if (!needed || !payload || !loginMethod) return null;
  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 rounded-control pr-2 pl-8"
      title={`${AGENT_NAME[agent]} isn't signed in on this Mac.`}
      data-testid="space-agent-sign-in"
      data-kind={agent}
    >
      <CircleAlert className="size-3.5 shrink-0 text-warning" strokeWidth={1.5} />
      <span className="min-w-0 truncate text-xs text-text-secondary">{AGENT_NAME[agent]} needs you to sign in</span>
      <AgentSignInButton
        agent={payload}
        loginMethod={loginMethod}
        onSignedIn={markSignedIn}
        className="bg-accent-subtle text-accent ml-auto shrink-0 rounded-chip px-2 py-0.5 text-2xs transition-opacity hover:opacity-80"
      />
    </div>
  );
}
