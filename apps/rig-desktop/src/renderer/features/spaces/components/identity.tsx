import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { agentLogoId, BrandLogo } from '../logos';
import type { AgentKind, RoomMember } from '../types';

/**
 * Who is speaking, drawn one way everywhere in a space: people are circles
 * (their photo, else initials), agents are rounded squares carrying their
 * brand mark with the owner as a small badge. The two shapes tell a person
 * from an agent without relying on color or the name.
 */

export const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };

type Size = 'md' | 'sm';

const PERSON_SIZE: Record<Size, string> = { md: 'size-7', sm: 'size-5' };

export function PersonAvatar({
  member,
  name,
  size = 'md',
  className,
}: {
  member: RoomMember | undefined;
  /** Shown (as initials) when the member isn't known. */
  name?: string;
  size?: Size;
  className?: string;
}) {
  return (
    <IdentityAvatar
      name={member?.name ?? name ?? null}
      avatarUrl={member?.avatarUrl ?? null}
      sizeClassName={PERSON_SIZE[size]}
      textClassName="text-2xs"
      className={className}
    />
  );
}

/** The owner's badge on an agent: their photo, else their first initial, small enough to sit on the corner. */
function OwnerBadge({ owner, className }: { owner: RoomMember | undefined; className?: string }) {
  if (owner?.avatarUrl) {
    return <img src={owner.avatarUrl} alt="" className={cn('rounded-full ring-2 ring-bg-1', className)} />;
  }
  const initial = (owner?.name ?? '?').trim().slice(0, 1).toUpperCase() || '?';
  return (
    <svg viewBox="0 0 16 16" className={cn('rounded-full ring-2 ring-bg-1', className)} aria-hidden>
      <circle cx="8" cy="8" r="8" className="fill-bg-3" />
      <text
        x="8"
        y="8"
        dy="0.35em"
        textAnchor="middle"
        className="fill-text-secondary font-sans font-semibold"
        style={{ fontSize: 9 }}
      >
        {initial}
      </text>
    </svg>
  );
}

const AGENT_BOX: Record<Size, string> = { md: 'size-7 rounded-card', sm: 'size-5 rounded-control' };
const AGENT_LOGO: Record<Size, number> = { md: 15, sm: 11 };
const BADGE: Record<Size, string> = { md: 'size-3.5 -right-1 -bottom-1', sm: 'size-3 -right-1 -bottom-1' };

export function AgentAvatar({
  agent,
  owner,
  size = 'md',
  className,
  title,
}: {
  agent: AgentKind;
  /** `null` = the agent kind itself, with no owner badge; `undefined` = an owner we can't resolve ("?"). */
  owner: RoomMember | undefined | null;
  size?: Size;
  className?: string;
  /** Overrides the native hover title; `null` drops it, for callers that wrap the avatar in their own tooltip. */
  title?: string | null;
}) {
  return (
    <span
      className={cn(
        'border-border-hairline bg-bg-2 relative inline-flex shrink-0 items-center justify-center border',
        AGENT_BOX[size],
        className
      )}
      title={title === undefined ? (owner ? `${owner.name}'s ${AGENT_NAME[agent]}` : AGENT_NAME[agent]) : (title ?? undefined)}
    >
      <BrandLogo id={agentLogoId(agent)} size={AGENT_LOGO[size]} />
      {owner !== null && <OwnerBadge owner={owner} className={cn('absolute', BADGE[size])} />}
    </span>
  );
}

const PERSON_AGENT_CHIP: Record<Size, { box: string; logo: number }> = {
  md: { box: 'size-3.5 rounded-[5px]', logo: 9 },
  sm: { box: 'size-3 rounded-[4px]', logo: 7 },
};

/**
 * An agent drawn person first: its owner's circle with a small model chip
 * (the agent's brand mark) on the bottom-right corner. The Room's rail and
 * the listener's notices draw agents this way, where the person is who
 * you look for and the model is the detail.
 */
export function PersonAgentAvatar({
  agent,
  owner,
  size = 'md',
  className,
  ringClassName = 'ring-bg-1',
  title,
}: {
  agent: AgentKind;
  /** `undefined` = an owner we can't resolve (their initials are unknown). */
  owner: RoomMember | undefined;
  size?: Size;
  className?: string;
  /** The ring that cuts the chip out of whatever it sits on. */
  ringClassName?: string;
  title?: string;
}) {
  const chip = PERSON_AGENT_CHIP[size];
  return (
    <span className={cn('relative inline-flex shrink-0', className)} title={title}>
      <PersonAvatar member={owner} size={size} />
      <span
        className={cn(
          'border-border-hairline bg-bg-2 absolute -right-1 -bottom-1 flex items-center justify-center border ring-2',
          chip.box,
          ringClassName
        )}
        data-testid="person-agent-chip"
        data-agent={agent}
      >
        <BrandLogo id={agentLogoId(agent)} size={chip.logo} />
      </span>
    </span>
  );
}
