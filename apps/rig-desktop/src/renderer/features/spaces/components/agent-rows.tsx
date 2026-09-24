import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { RoomSnapshot } from '../types';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { AGENT_NAME, AgentAvatar } from './identity';

/**
 * The viewer's own agents, as rows in the rig's pinned card (same 28px row
 * grammar): logo, name, and a pulse while one of its runs is working. In the
 * MVP a member can only tag their own agents, so these are the ones that
 * matter here; everyone's runs show up in the room as session cards.
 */
export function AgentRows({ snapshot, selfUserId }: { snapshot: RoomSnapshot; selfUserId: string }) {
  const mine = snapshot.agents.filter((a) => a.owner === selfUserId);
  if (mine.length === 0) return null;
  const runs = Object.values(snapshot.sessionMetaByRun);
  return (
    <>
      {mine.map((agent) => {
        const busy = runs.some(
          (meta) =>
            meta.owner === selfUserId &&
            meta.agent === agent.agent &&
            effectiveRunStatus(meta.status, projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? [])) ===
              'running'
        );
        return (
          <div
            key={agent.agent}
            className="flex h-7 shrink-0 items-center gap-2 rounded-control px-2"
            data-testid="space-agent-row"
          >
            <AgentAvatar agent={agent.agent} owner={snapshot.members.find((m) => m.id === selfUserId)} size="sm" />
            <span className="text-xs text-text-primary">{AGENT_NAME[agent.agent]}</span>
            <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-text-muted">
              {busy ? 'working' : `@${agent.agent}`}
              {busy && <DotMatrix state="thinking" size="sm" />}
            </span>
          </div>
        );
      })}
    </>
  );
}
