import { ArrowLeft } from 'lucide-react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { RoomSnapshot } from '../types';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';
import { deriveAgentTileState, describeAgentTileState } from './space-rail-status';

/**
 * Doc-focus round: the left rail that fills the sliver `App.tsx` gives the
 * Room in doc focus (the doc at full width) — replaces the old floating
 * bottom-right chip (`RoomView`'s own `collapsed` prop drew a
 * `position: fixed` chip that floated OVER the doc instead of living in
 * that column at all; see this file's own header comment for the
 * before/after). Icon-width by design — no separate collapse toggle: every
 * name/state lives in a tooltip rather than an always-on label, the same
 * "quiet" grammar the rest of the panel chrome already follows, so a
 * narrower rail never needs to lose anything to get there.
 *
 * Three groups, top to bottom: the way back to the Room beside the doc
 * (Split), the space's agents (each drawn the way the transcript draws
 * it — `AgentAvatar`'s brand mark with the owner's badge — plus a small
 * `DotMatrix` under it while something is live; its state comes straight
 * off the live Room snapshot, see `space-rail-status.ts`), and who's here
 * right now.
 */
export function SpaceRail({
  snapshot,
  selfUserId,
  onExpand,
}: {
  snapshot: RoomSnapshot;
  /** The viewer: their own agents read plain ("Claude finished"), everyone else's as theirs ("Sam's Claude finished"). */
  selfUserId?: string;
  /** Brings the Room back beside the doc (Split) — the rail's own "back" button. */
  onExpand?: () => void;
}) {
  const runs = Object.values(snapshot.sessionMetaByRun);
  const here = snapshot.members.filter((m) => m.online !== false && m.status !== 'invited');

  return (
    <div
      className="flex h-full w-full flex-col items-center gap-3 bg-bg-1 py-3"
      data-testid="space-rail"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onExpand?.()}
              aria-label="Back to the chat"
              data-testid="space-rail-back"
              className="text-text-muted hover:bg-bg-2 hover:text-text-primary flex size-8 shrink-0 items-center justify-center rounded-control transition-colors"
            >
              <ArrowLeft className="size-4" strokeWidth={1.5} />
            </button>
          }
        />
        <TooltipContent side="right">Back to the chat</TooltipContent>
      </Tooltip>

      {snapshot.agents.length > 0 && (
        <div className="flex flex-col items-center gap-2" data-testid="space-rail-agents">
          {snapshot.agents.map(({ agent, owner }) => {
            const ownerMember = snapshot.members.find((m) => m.id === owner);
            const runsOfAgent = runs.filter((m) => m.owner === owner && m.agent === agent);
            const state = deriveAgentTileState(runsOfAgent, snapshot, Date.now());
            const theirs = ownerMember && owner !== selfUserId ? ownerMember.name : undefined;
            const name = theirs ? `${theirs}'s ${AGENT_NAME[agent]}` : AGENT_NAME[agent];
            const label = describeAgentTileState(state, name, selfUserId !== undefined ? theirs : undefined);
            return (
              <Tooltip key={`${owner}:${agent}`}>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={label}
                      data-testid="space-rail-agent-tile"
                      data-kind={state.kind}
                      className="inline-flex shrink-0 flex-col items-center gap-1.5 rounded-control"
                    >
                      <AgentAvatar agent={agent} owner={ownerMember} title={null} />
                      {state.kind === 'live' && <DotMatrix state={state.state} size="sm" />}
                    </span>
                  }
                />
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      <div className="mt-auto flex flex-col items-center gap-1.5" data-testid="space-rail-people">
        {here.map((member) => (
          <Tooltip key={member.id}>
            <TooltipTrigger
              render={
                <span tabIndex={0} data-testid="space-rail-person" className="inline-flex">
                  <PersonAvatar member={member} size="sm" />
                </span>
              }
            />
            <TooltipContent side="right">{member.name}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
