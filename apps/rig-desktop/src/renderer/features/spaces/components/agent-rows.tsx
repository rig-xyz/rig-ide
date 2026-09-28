import { ChevronRight, Bot } from 'lucide-react';
import { useState } from 'react';
import { effectiveRunStatus, runCard } from '../projection';
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
  const cardOf = (runId: string) => runCard(snapshot, runId);
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
  // Polish round 2, lane F (Dylan): the collapsed summary shows each agent
  // KIND once — one Claude logo, one Codex logo — not one per (owner,
  // kind) instance; who's running which stays a per-row fact for the
  // expanded list below, not something the summary stack repeats itself.
  const summaryKinds = [...new Set(all.map(({ agent }) => agent))];

  return (
    <>
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className="hover:bg-bg-2 flex h-8 shrink-0 items-center gap-2 rounded-control px-2 text-left transition-colors"
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
              {summaryKinds.map((agent, i) => (
                <span key={agent} data-testid="agent-kind-avatar" data-kind={agent}>
                  <AgentAvatar
                    agent={agent}
                    // No single owner to badge — this glyph now stands for
                    // the KIND across everyone running it, not one person's
                    // instance of it.
                    owner={null}
                    size="sm"
                    className={cn('ring-bg-1 ring-2', i > 0 && '-ml-1.5')}
                  />
                </span>
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
        <div className="popover-in flex shrink-0 flex-col pt-1 pb-1.5" data-testid="agents-expanded">
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
                className="flex h-7 shrink-0 items-center gap-2 rounded-control pr-2 pl-8"
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
                    <span className="h-2 w-12 animate-pulse rounded-full bg-bg-3" data-testid="agent-model-loading" />
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

/** The one thing the collapsed chip reports beside the faces: the most urgent true state, or nothing. */
export type SpaceChipStatus =
  | { kind: 'offline' }
  | { kind: 'needs-you'; agent: AgentKind }
  | { kind: 'yours-working'; agents: AgentKind[] }
  | { kind: 'others-working'; owner: string; agent: AgentKind; count: number }
  | { kind: 'new'; count: number };

/**
 * Most urgent first: one of your agents is waiting on your approval; your
 * agent is working; someone else's is; files changed that you haven't
 * opened; last, and quietly, the Room is updating by polling because the
 * live connection is down (nothing is broken, so it never outranks news).
 * Sync, connectors to connect and the rest stay inside the panel.
 */
export function spaceChipStatus(snapshot: RoomSnapshot, selfUserId: string, unseenCount: number): SpaceChipStatus | null {
  const running: Array<{ owner: string; agent: AgentKind }> = [];
  for (const meta of Object.values(snapshot.sessionMetaByRun)) {
    const card = runCard(snapshot, meta.id);
    if (effectiveRunStatus(meta.status, card) !== 'running') continue;
    if (meta.owner === selfUserId && card.permissions.pending.length > 0) return { kind: 'needs-you', agent: meta.agent };
    running.push({ owner: meta.owner, agent: meta.agent });
  }
  const mine = running.filter((r) => r.owner === selfUserId);
  if (mine.length > 0) return { kind: 'yours-working', agents: [...new Set(mine.map((r) => r.agent))] };
  if (running.length > 0) {
    const first = running[0]!;
    const owner = snapshot.members.find((m) => m.id === first.owner)?.name ?? 'Someone';
    return { kind: 'others-working', owner, agent: first.agent, count: running.length };
  }
  if (unseenCount > 0) return { kind: 'new', count: unseenCount };
  if (snapshot.connection === 'offline') return { kind: 'offline' };
  return null;
}

function namesHere(names: string[]): string {
  if (names.length === 0) return 'Nobody else is here';
  if (names.length === 1) return `${names[0]} is here`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are here`;
}

/**
 * What the collapsed space panel chip says: the faces of who's here (no
 * count; the tooltip names them) and one status slot, see `spaceChipStatus`.
 */
export function SpaceChipSummary({
  snapshot,
  selfUserId,
  unseenCount,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  unseenCount: number;
}) {
  const here = snapshot.members.filter((m) => m.online !== false && m.status !== 'invited');
  const status = spaceChipStatus(snapshot, selfUserId, unseenCount);
  return (
    <span className="flex items-center gap-2 text-xs text-text-secondary" data-testid="space-chip-summary">
      <span className="flex items-center" title={namesHere(here.map((m) => m.name))}>
        {here.slice(0, 3).map((m, i) => (
          <PersonAvatar key={m.id} member={m} size="sm" className={i > 0 ? '-ml-1.5 ring-2 ring-bg-1' : 'ring-2 ring-bg-1'} />
        ))}
      </span>
      {status && <ChipStatus status={status} />}
    </span>
  );
}

function ChipStatus({ status }: { status: SpaceChipStatus }) {
  switch (status.kind) {
    case 'offline':
      return (
        <span
          className="flex items-center gap-1.5 text-text-muted"
          title="The live connection is down, so the chat checks for news every few seconds."
          data-testid="chip-status"
          data-kind="offline"
        >
          <span className="bg-border-strong size-1.5 rounded-full" />
          Updating slower
        </span>
      );
    case 'needs-you':
      return (
        <span className="flex items-center gap-1.5 text-text-primary" data-testid="chip-status" data-kind="needs-you">
          <DotMatrix state="waiting" size="sm" />
          {AGENT_NAME[status.agent]} needs you
        </span>
      );
    case 'yours-working':
      return (
        <span className="flex items-center gap-1.5" data-testid="chip-status" data-kind="yours-working">
          <DotMatrix state="thinking" size="sm" />
          {status.agents.length === 1 ? `${AGENT_NAME[status.agents[0]!]} working` : `${status.agents.length} agents working`}
        </span>
      );
    case 'others-working':
      return (
        <span className="flex items-center gap-1.5 text-text-muted" data-testid="chip-status" data-kind="others-working">
          <DotMatrix state="thinking" size="sm" />
          {status.count === 1 ? `${status.owner}'s ${AGENT_NAME[status.agent]} working` : `${status.count} agents working`}
        </span>
      );
    case 'new':
      return (
        <span
          className="bg-accent-subtle text-accent rounded-chip px-1.5 text-2xs tabular-nums"
          title={`${status.count} new or changed ${status.count === 1 ? 'file' : 'files'}`}
          data-testid="chip-status"
          data-kind="new"
        >
          {status.count} new
        </span>
      );
  }
}
