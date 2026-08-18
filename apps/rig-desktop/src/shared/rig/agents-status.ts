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
