import { defineEvent } from '../lib/ipc/events';

/**
 * Broadcast whenever the set of RUNNABLE agent providers changes (a
 * `--version` runnability probe landed with a different verdict than the
 * current set) — the renderer invalidates its `rpc.agents.list()` query on
 * it, so a slow probe (claude's node CLI takes ~1s cold vs codex's ~40ms)
 * still pops into the harness picker the moment it lands instead of waiting
 * out a stale-time or a window refocus. See `main/rig/agent-runnability.ts`.
 */
export const rigAgentRunnabilityChangedChannel = defineEvent<{ runnableAgents: string[] }>(
  'rig:agent-runnability-changed'
);

/**
 * Broadcast whenever the set of agents that need their owner to sign in
 * again on this Mac changes: a run failed on an expired sign-in, or a sign-in
 * or a later run of that agent went through. `claude auth status` can still
 * say signed in after the token on disk expired, so this is what tells Home
 * and the space panel. See `main/rig/agent-sign-in-needed.ts`.
 */
export const rigAgentSignInNeededChannel = defineEvent<{ agents: Array<'claude' | 'codex'> }>(
  'rig:agent-sign-in-needed'
);
