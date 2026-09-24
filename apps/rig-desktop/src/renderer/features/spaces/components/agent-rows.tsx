import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { AgentKind, RoomSnapshot } from '../types';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { AgentConfigRow } from './agent-settings';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

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
  // The model your agent last ran here, until its own list is loaded.
  const lastModel = (kind: AgentKind): string | null => {
    const latest = runs
      .filter((m) => m.owner === selfUserId && m.agent === kind)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    if (!latest) return null;
    return projectSessionCard(snapshot.sessionEventsByRun[latest.id] ?? []).model ?? (latest.model !== 'unknown' ? latest.model : null);
  };
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
        const latest = runs
          .filter((m) => m.owner === selfUserId && m.agent === agent.agent)
          .sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt))[0];
        return (
          <AgentConfigRow
            key={agent.agent}
            agent={agent.agent}
            avatar={<AgentAvatar agent={agent.agent} owner={snapshot.members.find((m) => m.id === selfUserId)} size="sm" />}
            busy={busy ? <DotMatrix state="thinking" size="sm" /> : null}
            lastModel={lastModel(agent.agent) ?? (agent.model || null)}
            usage={latest ? projectSessionCard(snapshot.sessionEventsByRun[latest.id] ?? []).usage : null}
          />
        );
      })}
    </>
  );
}

/**
 * What the collapsed space panel chip says: who's here (their faces and a
 * count) and, when any agent in the space is working, the matrix and whose.
 */
export function SpaceChipSummary({ snapshot }: { snapshot: RoomSnapshot }) {
  const here = snapshot.members.filter((m) => m.online !== false && m.status !== 'invited');
  const working = Object.values(snapshot.sessionMetaByRun).filter(
    (meta) =>
      effectiveRunStatus(meta.status, projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? [])) === 'running'
  );
  const firstOwner = working[0] ? snapshot.members.find((m) => m.id === working[0]!.owner) : undefined;
  return (
    <span className="flex items-center gap-2 text-xs text-text-secondary">
      <span className="flex items-center">
        {here.slice(0, 3).map((m, i) => (
          <PersonAvatar key={m.id} member={m} size="sm" className={i > 0 ? '-ml-1.5 ring-2 ring-bg-1' : 'ring-2 ring-bg-1'} />
        ))}
      </span>
      <span className="tabular-nums">{here.length} here</span>
      {working.length > 0 && (
        <>
          <span className="bg-border-hairline h-3 w-px" />
          <DotMatrix state="thinking" size="sm" />
          <span>
            {working.length === 1
              ? `${firstOwner?.name ?? 'Someone'}'s ${AGENT_NAME[working[0]!.agent]} working`
              : `${working.length} agents working`}
          </span>
        </>
      )}
    </span>
  );
}
