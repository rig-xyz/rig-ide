import { effectiveRunStatus, projectSessionCard } from '../projection';
import { agentLogoId, BrandLogo } from '../logos';
import type { RoomSnapshot } from '../types';

const AGENT_NAME: Record<'claude' | 'codex', string> = { claude: 'Claude', codex: 'Codex' };

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
            <BrandLogo id={agentLogoId(agent.agent)} size={14} />
            <span className="text-xs text-text-primary">{AGENT_NAME[agent.agent]}</span>
            <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-text-muted">
              {busy ? 'working' : `@${agent.agent}`}
              {busy && <span className="bg-accent size-1.5 animate-pulse rounded-full" />}
            </span>
          </div>
        );
      })}
    </>
  );
}
