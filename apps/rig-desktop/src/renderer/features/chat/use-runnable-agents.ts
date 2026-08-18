import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import type { AgentIconAsset, AgentPayload } from '@shared/core/agents/agent-payload';
import { rigAgentRunnabilityChangedChannel } from '@shared/rig/agents-status';

export type RunnableAgent = { id: string; name: string; icon: AgentIconAsset };

/**
 * Harness picker data source: agents that are both installed AND runnable
 * right now, per `packages/core`'s own dependency probe (`status ===
 * 'available'`) — not a curated list. An agent the user hasn't installed, or
 * whose binary the probe can't find, is absent from this list rather than
 * shown disabled — the honest status the mission asked for, matching how
 * `main/rig/comment-agent.ts` rejects an unrunnable provider before ever
 * spawning it.
 *
 * This is `rpc.agents.list()` — gated behind `getDependencyManager` +
 * `ensureAgentDependenciesProbed`, which runs a `--version` probe per
 * candidate on first call. Correctly used for anything that answers "can a
 * session be started with this agent right now" (this hook itself, the
 * harness picker's own option list, the composer's disabled/placeholder
 * state). Never appropriate for a pure icon/name lookup on an ALREADY
 * decided provider — see `useAgentIdentities` below.
 */
export function useRunnableAgents() {
  const queryClient = useQueryClient();
  const query = useQuery<AgentPayload[]>({
    queryKey: ['rig', 'agents', 'list'],
    queryFn: () => rpc.agents.list() as Promise<AgentPayload[]>,
    staleTime: 60_000,
  });

  // A slow probe landing AFTER the first snapshot (claude's node CLI takes
  // ~1s cold; codex ~40ms) used to stay invisible until the stale-time
  // expired or the window refocused — main now pushes on every runnability
  // change (`main/rig/agent-runnability.ts`), and this refetch is what makes
  // a late probe "populate" the picker the moment it lands.
  useEffect(
    () =>
      events.on(rigAgentRunnabilityChangedChannel, () => {
        void queryClient.invalidateQueries({ queryKey: ['rig', 'agents', 'list'] });
      }),
    [queryClient]
  );

  const agents: RunnableAgent[] = (query.data ?? [])
    .filter((agent) => agent.status === 'available')
    .map((agent) => ({ id: agent.id, name: agent.name, icon: agent.icon }));

  return { ...query, agents };
}

export type AgentIdentity = { name: string; icon: AgentIconAsset };

/**
 * Provider id → its static identity (name + icon), for every provider in
 * the catalog — never filtered to installed/runnable. Fixes a real bug: a
 * tab or History row for an already-chosen provider (a resumed session, a
 * stored session, an already-open tab) has nothing to do with whether that
 * provider is runnable *right now* — its icon is a bundled asset
 * (`agent-payload-builder.ts`'s `assets.icon`), fixed at build time, not a
 * probe result. Sourcing it from `useRunnableAgents()`/`rpc.agents.list()`
 * meant every tab/row rendered icon-less for however long the `--version`
 * probes took on launch, then popped in once the probed list resolved.
 *
 * `rpc.agents.listMetadata()` reads the in-memory plugin registry directly
 * (`buildAgentMetadataList` → `listPlugins().map(buildMetadata)`) — no
 * dependency manager, no probing, effectively instant — so this never has
 * a "before the probe resolves" state to flash through. Mirrors the same
 * pattern `comments-margin.tsx`'s own `useAgentIcons` already established
 * for the exact same reason (a posted comment's mark shouldn't blink out
 * while agents are being probed, or disappear if the provider is later
 * uninstalled).
 */
export function useAgentIdentities(): Map<string, AgentIdentity> {
  const { data } = useQuery({
    queryKey: ['agents', 'metadata'],
    queryFn: () => rpc.agents.listMetadata(),
    staleTime: Infinity,
  });
  return useMemo(
    () => new Map((data ?? []).map((agent) => [agent.id, { name: agent.name, icon: agent.icon }])),
    [data]
  );
}
