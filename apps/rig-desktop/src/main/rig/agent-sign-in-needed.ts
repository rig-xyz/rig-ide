import { events } from '@main/lib/events';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigAgentSignInNeededChannel } from '@shared/rig/agents-status';
import type { AgentCli } from '@shared/telemetry';
import { isSignInFailure, type AgentFailurePhase } from './agent-run-failure';

/**
 * Which agents need their owner to sign in again on this Mac. Set when a run
 * fails on its sign-in (`isSignInFailure`), because
 * `claude auth status` can still report signed in once the OAuth token on
 * disk has expired and can't refresh. Cleared by a sign-in from the app, or
 * by the next run of that agent that finishes. In memory only: a restart
 * forgets it, and the next failed run sets it again.
 */
const needed = new Set<AgentCli>();

function publish(): void {
  events.emit(rigAgentSignInNeededChannel, { agents: [...needed].sort() });
}

/** Records a failed run; only a sign-in failure marks the agent. */
export function noteAgentRunFailedForSignIn(failure: { agent: AgentCli; text: string; phase: AgentFailurePhase }): void {
  if (needed.has(failure.agent)) return;
  if (failure.phase === 'stalled' || !isSignInFailure(failure.text)) return;
  needed.add(failure.agent);
  publish();
}

/** The agent signed in, or one of its runs finished: it no longer needs a sign-in. */
export function clearAgentSignInNeeded(agent: AgentCli): void {
  if (!needed.delete(agent)) return;
  publish();
}

export const rigAgentSignInController = createRPCController({
  needed: async (): Promise<AgentCli[]> => [...needed].sort(),
  /** The sign-in dialog finished for this agent. */
  signedIn: async (agent: AgentCli): Promise<void> => clearAgentSignInNeeded(agent),
});
