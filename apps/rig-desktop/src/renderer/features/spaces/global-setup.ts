import type { AgentKind } from './types';
import type { GlobalServer } from '@shared/spaces/connectors';

/**
 * Pure helpers over `GlobalServer[]` (see `@shared/spaces/connectors`'s own
 * header comment): what a person's agents already bring from their own
 * global MCP setup (claude.ai connectors + ~/.claude for Claude, ~/.codex
 * for Codex), read once per Room through `connectors-api.ts`'s
 * `globalSetup()` and kept in `RoomView`'s own state. Rig never changes this
 * setup — these helpers only decide how to word and gate the Surface (the
 * space panel's quiet sub-line and disclosure, the gallery's footer note,
 * and a turn's gap pills) over it.
 */

/** Which of your agents already reach this catalog connector this way. */
export function globalAgentsFor(connectorId: string, servers: readonly GlobalServer[]): Set<AgentKind> {
  const agents = new Set<AgentKind>();
  for (const server of servers) {
    if (server.connectorId === connectorId) agents.add(server.agent);
  }
  return agents;
}

/** "Claude" / "Codex" / "Claude and Codex", from the agents that bring it. */
export function globalAgentsLabel(agents: ReadonlySet<AgentKind>): string {
  if (agents.has('claude') && agents.has('codex')) return 'Claude and Codex';
  return agents.has('claude') ? 'Claude' : 'Codex';
}

/**
 * The space panel row's quiet sub-line for a connector you haven't
 * connected via rig, but one of your agents already reaches this way — e.g.
 * "Via your Claude setup". Null when no agent has it.
 */
export function viaGlobalSetupLabel(connectorId: string, servers: readonly GlobalServer[]): string | null {
  const agents = globalAgentsFor(connectorId, servers);
  return agents.size > 0 ? `Via your ${globalAgentsLabel(agents)} setup` : null;
}

/**
 * The gallery card footer's note for a catalog tool your agents already
 * reach this way — e.g. "In your Claude setup". Null when no agent has it.
 */
export function inGlobalSetupLabel(connectorId: string, servers: readonly GlobalServer[]): string | null {
  const agents = globalAgentsFor(connectorId, servers);
  return agents.size > 0 ? `In your ${globalAgentsLabel(agents)} setup` : null;
}

/** One agent's servers, for the panel's "also bring" disclosure. */
export interface GlobalSetupGroup {
  agent: AgentKind;
  servers: GlobalServer[];
}

/** Groups by agent (Claude first, then Codex), leaving out an agent with nothing. */
export function groupGlobalSetup(servers: readonly GlobalServer[]): GlobalSetupGroup[] {
  const groups: GlobalSetupGroup[] = [];
  for (const agent of ['claude', 'codex'] as const) {
    const mine = servers.filter((s) => s.agent === agent);
    if (mine.length > 0) groups.push({ agent, servers: mine });
  }
  return groups;
}

/** A server's own name with a leading "claude.ai " stripped, e.g. "claude.ai Linear" → "Linear". */
export function displayServerName(name: string): string {
  return name.replace(/^claude\.ai\s+/, '');
}
