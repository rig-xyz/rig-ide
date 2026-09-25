import { ArrowLeft } from 'lucide-react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { RoomSnapshot } from '../types';
import { AGENT_NAME, PersonAvatar } from './identity';
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
 * (Split), the space's agents (each its own small status tile — the 1b
 * grammar `features/home/space-status-tile.tsx` established for the home
 * list, restyled locally since that component takes a `RigSpaceStatus`
 * and this rail has no such thing to hand it — its own state comes
 * straight off the live Room snapshot, see `space-rail-status.ts`), and
 * who's here right now.
 */
export function SpaceRail({
  snapshot,
  onExpand,
}: {
  snapshot: RoomSnapshot;
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
              aria-label="Back to the Room"
              data-testid="space-rail-back"
              className="text-text-muted hover:bg-bg-2 hover:text-text-primary flex size-8 shrink-0 items-center justify-center rounded-control transition-colors"
            >
              <ArrowLeft className="size-4" strokeWidth={1.5} />
            </button>
          }
        />
        <TooltipContent side="right">Back to the Room</TooltipContent>
      </Tooltip>

      {snapshot.agents.length > 0 && (
        <div className="flex flex-col items-center gap-2" data-testid="space-rail-agents">
          {snapshot.agents.map(({ agent, owner }) => {
            const ownerMember = snapshot.members.find((m) => m.id === owner);
            const runsOfAgent = runs.filter((m) => m.owner === owner && m.agent === agent);
            const state = deriveAgentTileState(runsOfAgent, snapshot, Date.now());
            const name = ownerMember ? `${ownerMember.name}'s ${AGENT_NAME[agent]}` : AGENT_NAME[agent];
            const label = describeAgentTileState(state, name);
            return (
              <Tooltip key={`${owner}:${agent}`}>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      data-testid="space-rail-agent-tile"
                      data-kind={state.kind}
                      className="bg-bg-2 inline-flex size-8 shrink-0 items-center justify-center rounded-control"
                    >
                      {state.kind === 'live' ? (
                        <DotMatrix state={state.state} size="sm" label={label} />
                      ) : (
                        <QuietDots label={label} />
                      )}
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

/** Mirrors `space-status-tile.tsx`'s own still-dots grid (a quiet tile's "nothing to see" look) — small enough to duplicate locally rather than reach into `features/home`, which this round doesn't otherwise touch. */
function QuietDots({ label }: { label: string }) {
  return (
    <span className={cn('inline-grid grid-cols-3 gap-0.5')} role="img" aria-label={label}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="bg-text-muted size-1 rounded-full opacity-20" />
      ))}
    </span>
  );
}
