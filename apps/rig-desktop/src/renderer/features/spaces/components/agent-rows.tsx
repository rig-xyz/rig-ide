import { ChevronRight, Bot } from 'lucide-react';
import { useState } from 'react';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { AgentKind, RoomSnapshot } from '../types';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { readPanelSectionExpanded, writePanelSectionExpanded } from '../panel-section-storage';
import { AgentConfigRow, prettyModelId } from './agent-settings';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

/**
 * The viewer's own agents, as rows in the rig's pinned card (same 28px row
 * grammar): logo, name, and a pulse while one of its runs is working. In the
 * MVP a member can only tag their own agents, so these are the ones that
 * matter here; everyone's runs show up in the room as session cards.
 *
 * Collapsed by default behind one summary row (a small stack of the same
 * agent marks, same disclosure grammar as the pinned card's People/Files/
 * Skills rows) — remembered per space, like `ConnectorsSection`'s.
 */
export function AgentRows({
  snapshot,
  selfUserId,
  bindingId,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** Keys this section's remembered expanded/collapsed state to its space. */
  bindingId: string;
}) {
  const runs = Object.values(snapshot.sessionMetaByRun);
  const runsOf = (owner: string, kind: AgentKind) =>
    runs
      .filter((m) => m.owner === owner && m.agent === kind)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const cardOf = (runId: string) => projectSessionCard(snapshot.sessionEventsByRun[runId] ?? []);
  const isWorking = (owner: string, kind: AgentKind) =>
    runsOf(owner, kind).some((meta) => effectiveRunStatus(meta.status, cardOf(meta.id)) === 'running');
  // The model an agent last ran here, as its latest run reported it.
  const lastModel = (owner: string, kind: AgentKind): string | null => {
    const latest = runsOf(owner, kind)[0];
    if (!latest) return null;
    const model = cardOf(latest.id).model ?? (latest.model !== 'unknown' ? latest.model : null);
    return model ? prettyModelId(model) : null;
  };

  const mine = snapshot.agents.filter((a) => a.owner === selfUserId);
  // Everyone else's agents that have worked in this space: shown so you know
  // what they run, but only their owner can change them.
  const theirs = new Map<string, { owner: string; agent: AgentKind }>();
  for (const meta of runs) {
    if (meta.owner === selfUserId) continue;
    theirs.set(`${meta.owner}:${meta.agent}`, { owner: meta.owner, agent: meta.agent });
  }

  // Collapsed by default, remembered per space. Hook runs unconditionally,
  // above the early return below (Rules of Hooks: `mine`/`theirs` can go
  // from empty to non-empty between renders).
  const [expanded, setExpanded] = useState(() => readPanelSectionExpanded(bindingId, 'agents') ?? false);
  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current;
      writePanelSectionExpanded(bindingId, 'agents', next);
      return next;
    });
  };

  if (mine.length === 0 && theirs.size === 0) return null;

  const all = [...mine.map((agent) => ({ owner: selfUserId, agent: agent.agent })), ...theirs.values()];

  return (
    <>
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className="hover:bg-bg-2 flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-left transition-colors"
        data-testid="agents-summary-row"
      >
        <Bot className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <span className="text-xs text-text-primary">Agents</span>
        <span className="ml-auto flex items-center gap-1.5">
          {/* Once expanded, the rows below already say who's who — the
              summary's own logo stack is redundant then (same rule as
              the Connectors row's logos). */}
          {!expanded && (
            <span className="flex items-center" data-testid="agents-avatar-stack">
              {all.map(({ owner, agent }, i) => (
                <AgentAvatar
                  key={`${owner}:${agent}`}
                  agent={agent}
                  owner={snapshot.members.find((m) => m.id === owner)}
                  size="sm"
                  className={cn('ring-bg-1 ring-2', i > 0 && '-ml-1.5')}
                />
              ))}
            </span>
          )}
          <ChevronRight
            className={cn('size-3 shrink-0 text-text-muted transition-transform', expanded && 'rotate-90')}
            strokeWidth={1.5}
          />
        </span>
      </button>
      {expanded && (
        <div className="popover-in flex shrink-0 flex-col" data-testid="agents-expanded">
          {mine.map((agent) => {
            const latest = runsOf(selfUserId, agent.agent)[0];
            return (
              <AgentConfigRow
                key={agent.agent}
                agent={agent.agent}
                avatar={<AgentAvatar agent={agent.agent} owner={snapshot.members.find((m) => m.id === selfUserId)} size="sm" />}
                busy={isWorking(selfUserId, agent.agent) ? <DotMatrix state="thinking" size="sm" /> : null}
                lastModel={lastModel(selfUserId, agent.agent) ?? (agent.model || null)}
                usage={latest ? cardOf(latest.id).usage : null}
              />
            );
          })}
          {[...theirs.values()].map(({ owner, agent }) => {
            const member = snapshot.members.find((m) => m.id === owner);
            const ownerName = member?.name ?? owner;
            // `theirs` only holds agents with at least one run here, so a
            // null model means that run just hasn't reported one yet — a
            // quiet phantom reads truer than a blank or stale label.
            const model = lastModel(owner, agent);
            return (
              <div
                key={`${owner}:${agent}`}
                className="flex h-7 shrink-0 items-center gap-2 rounded-control px-2"
                title={`Only ${ownerName} can change ${ownerName}'s ${AGENT_NAME[agent]}`}
                data-testid="space-agent-row-theirs"
              >
                <AgentAvatar agent={agent} owner={member} size="sm" />
                <span className="min-w-0 truncate text-xs text-text-secondary">
                  {ownerName}'s {AGENT_NAME[agent]}
                </span>
                <span className="ml-auto flex min-w-0 items-center gap-1.5 text-2xs text-text-muted">
                  {isWorking(owner, agent) && <DotMatrix state="thinking" size="sm" />}
                  {model ? (
                    <span className="truncate">{model}</span>
                  ) : (
                    <DotMatrix state="starting" size="sm" label="Loading" />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
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
