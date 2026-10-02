import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';
import { DotMatrix, type DotMatrixActivity } from '@renderer/lib/ui/dot-matrix';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  agentDisplayName,
  pendingFor,
  railAgents,
  railMembers,
  type RailAgent,
  type RailMember,
} from '../dock-model';
import type { ForYou } from '../for-you';
import type { AgentKind, RoomSnapshot } from '../types';
import { FOCUS_RING } from './dock-glass';
import { PersonAgentAvatar, PersonAvatar } from './identity';
import { deriveAgentTileState, describeAgentTileState } from './space-rail-status';

/**
 * The rail's content: the Room's pinned-card chip, rebuilt for the dock. Left to
 * right: the listener (a dot matrix), who is here, then agents drawn person first (their
 * owner's face, the model on the corner), and at the end a slot for the dock's
 * one toggle (`theme-dock.tsx`), the chevron that opens the pinned panel. The
 * rail hugs what it holds. Your own agents carry a badge with the approvals waiting on
 * you, and open the approvals panel (`dock-approvals.tsx`).
 *
 * The capsule behind it is a shape in the dock's goo layer (`dock-stage.tsx`),
 * not drawn here, and so is the panel's: this is only what sits on top.
 */

/** The listener's motion: it breathes while it listens, hops while theme events arrive, ripples out at a birth. */
export type ListenerState = Extract<DotMatrixActivity, 'waiting' | 'searching' | 'starting'>;

/**
 * The listener: the app's own dot matrix at the start of the rail, in a slot
 * the size of an avatar. Idle it breathes in the center (`waiting`); while theme events
 * arrive it searches; at a birth it ripples out (`starting`), and the new
 * theme's drop comes out of this spot (`dock-stage.tsx` tucks births back
 * into it, `BEAD_INSET` in `dock-layout.ts`).
 */
function ListenerMatrix({ state, hearing }: { state: ListenerState; hearing: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="flex size-7 shrink-0 items-center justify-center"
            data-testid="dock-listener"
            data-hearing={hearing ? 'true' : 'false'}
          >
            {/* The medium matrix is 16px, centered in a slot the size of an avatar: the same weight as one. */}
            <DotMatrix state={state} size="md" label="Listening for themes" />
          </span>
        }
      />
      <TooltipContent side="bottom">Listening for themes</TooltipContent>
    </Tooltip>
  );
}

/**
 * "About to post": a soft accent ring around an avatar while that person is
 * typing or that agent is working. Drawn on the content layer, never as a goo
 * shape, so it does not melt into the rail; absolutely placed around the
 * avatar, so it changes neither its size nor the rail's layout. Purely
 * decorative: the avatar's accessible name carries the state, no live region.
 */
function Halo() {
  const reduced = useReducedMotion() ?? false;
  return (
    <span
      className="dock-halo pointer-events-none absolute -inset-[3px]"
      data-testid="dock-halo"
      data-motion={reduced ? 'off' : 'on'}
      aria-hidden
    >
      <span className="dock-halo-ring absolute inset-0" />
    </span>
  );
}

/** Away people and idle agents: still recognizable, but out of the way. */
const GREYED = 'opacity-45 grayscale';

/** "+N": the people or agents that did not fit, a small chip that opens the pinned panel. */
function MoreChip({
  count,
  label,
  testId,
  onClick,
}: {
  count: number;
  label: string;
  testId: string;
  onClick: (() => void) | undefined;
}) {
  const text = `+${count}`;
  const className =
    'rounded-full px-1 text-2xs text-text-muted tabular-nums transition-colors hover:text-text-primary';
  if (!onClick) {
    return (
      <span className={className} data-testid={testId}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className={cn(className, FOCUS_RING)}
    >
      {text}
    </button>
  );
}

function memberLabel({ member, present, typing }: RailMember): string {
  return typing ? `${member.name}, typing` : present ? member.name : `${member.name}, away`;
}

function Members({
  snapshot,
  selfUserId,
  onMore,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  onMore: (() => void) | undefined;
}) {
  const { shown, more } = railMembers(snapshot, selfUserId);
  if (shown.length === 0) return null;
  return (
    <span className="flex items-center gap-[5px]" data-testid="dock-members">
      {shown.map((entry) => {
        const { member, present, typing } = entry;
        return (
          <Tooltip key={member.id}>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={memberLabel(entry)}
                  className="relative rounded-full transition-transform hover:-translate-y-0.5"
                  data-testid="dock-member"
                  data-presence={present ? 'here' : 'away'}
                >
                  <span
                    className={cn(
                      'inline-flex rounded-full transition-[opacity,filter]',
                      !present && GREYED
                    )}
                  >
                    <PersonAvatar member={member} size="md" />
                  </span>
                  {typing && <Halo />}
                </span>
              }
            />
            <TooltipContent side="bottom">
              {member.id === selfUserId
                ? 'You are here'
                : `${member.name} is ${present ? 'here' : 'away'}`}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {more > 0 && (
        <MoreChip
          count={more}
          label={`${more} more ${more === 1 ? 'person' : 'people'}`}
          testId="dock-members-more"
          onClick={onMore}
        />
      )}
    </span>
  );
}

/** The count of approvals waiting, on the corner of your agent. */
function ApprovalsBadge({ count }: { count: number }) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.span
          className="pointer-events-none absolute -top-1.5 -right-2 z-10 min-w-[15px] rounded-full bg-accent px-1 text-center font-mono text-2xs leading-[15px] font-semibold text-accent-ink ring-2 ring-[var(--pill-fill)]"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 28 }}
          data-testid="dock-approvals-badge"
        >
          {count}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function AgentTile({
  railAgent,
  snapshot,
  pending,
  open,
  onToggle,
}: {
  railAgent: RailAgent;
  snapshot: RoomSnapshot;
  pending: number;
  open: boolean;
  onToggle: () => void;
}) {
  const owner = snapshot.members.find((m) => m.id === railAgent.owner);
  const ownerName = railAgent.own ? null : (owner?.name ?? 'Someone');
  const name = agentDisplayName(railAgent.agent, ownerName);
  const runs = Object.values(snapshot.sessionMetaByRun).filter(
    (m) => m.owner === railAgent.owner && m.agent === railAgent.agent
  );
  const state = deriveAgentTileState(runs, snapshot, Date.now());
  const label = describeAgentTileState(state, name, ownerName ?? undefined);
  // Working, the rule the tooltip and the chip share: a running turn that is not waiting on an approval.
  const working = state.kind === 'live' && state.state === 'thinking';
  const avatar = (
    <span
      className={cn(
        'inline-flex rounded-full transition-[opacity,filter]',
        !railAgent.active && GREYED
      )}
    >
      <PersonAgentAvatar
        agent={railAgent.agent}
        owner={owner}
        ringClassName="ring-[var(--pill-fill)]"
      />
    </span>
  );
  const tile = railAgent.own ? (
    <button
      type="button"
      onClick={onToggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={
        pending > 0
          ? `${name}, ${pending} ${pending === 1 ? 'approval' : 'approvals'} waiting`
          : working
            ? `${name}, working`
            : name
      }
      data-testid="dock-agent"
      data-own="true"
      data-agent={railAgent.agent}
      data-state={railAgent.active ? 'active' : 'idle'}
      className={cn(
        'relative inline-flex rounded-full transition-transform hover:-translate-y-0.5',
        FOCUS_RING
      )}
    >
      {avatar}
      {working && <Halo />}
      <ApprovalsBadge count={pending} />
    </button>
  ) : (
    <span
      tabIndex={0}
      role="img"
      aria-label={label}
      data-testid="dock-agent"
      data-own="false"
      data-agent={railAgent.agent}
      data-state={railAgent.active ? 'active' : 'idle'}
      className="relative inline-flex rounded-full transition-transform hover:-translate-y-0.5"
    >
      {avatar}
      {working && <Halo />}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={tile} />
      <TooltipContent side="bottom">
        {railAgent.own && pending > 0 ? `${label}. Click to review.` : label}
      </TooltipContent>
    </Tooltip>
  );
}

export function DockRail({
  snapshot,
  selfUserId,
  forYou,
  hearing,
  birthing,
  openAgent,
  onToggleAgent,
  onExpand,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  forYou: ForYou;
  hearing: boolean;
  /** A birth is under way: the listener ripples. */
  birthing: boolean;
  openAgent: AgentKind | null;
  onToggleAgent: (agent: AgentKind) => void;
  /**
   * Opens the pinned panel at a section ("+N" people goes to People, "+N"
   * agents to the panel as it is). Its presence also leaves a slot at the end
   * for the dock's toggle. Absent (the scripted demo): no slot, and "+N" is a
   * plain count.
   */
  onExpand?: (section?: 'people') => void;
}) {
  const { shown: agents, more: moreAgents } = useMemo(
    () => railAgents(snapshot, selfUserId),
    [snapshot, selfUserId]
  );
  return (
    <div className="flex h-10 items-center gap-[5px] pr-1.5 pl-3" data-testid="dock-rail">
      <ListenerMatrix state={birthing ? 'starting' : hearing ? 'searching' : 'waiting'} hearing={hearing} />
      <Members
        snapshot={snapshot}
        selfUserId={selfUserId}
        onMore={onExpand ? () => onExpand('people') : undefined}
      />
      {agents.length > 0 && (
        <>
          <span className="mx-1 h-4 w-px bg-border-hairline" aria-hidden />
          <span className="flex items-center gap-[5px]" data-testid="dock-agents">
            {agents.map((railAgent) => (
              <AgentTile
                key={`${railAgent.owner}:${railAgent.agent}`}
                railAgent={railAgent}
                snapshot={snapshot}
                pending={railAgent.own ? pendingFor(forYou, railAgent.agent) : 0}
                open={openAgent === railAgent.agent && railAgent.own}
                onToggle={() => onToggleAgent(railAgent.agent)}
              />
            ))}
            {moreAgents > 0 && (
              <MoreChip
                count={moreAgents}
                label={`${moreAgents} more ${moreAgents === 1 ? 'agent' : 'agents'}`}
                testId="dock-agents-more"
                onClick={onExpand ? () => onExpand() : undefined}
              />
            )}
          </span>
        </>
      )}
      {/* Where the dock's toggle sits, drawn by the stage over this slot so it stays put as the rail becomes the panel. */}
      {onExpand && <span className="size-7 shrink-0" data-testid="dock-rail-corner" aria-hidden />}
    </div>
  );
}
