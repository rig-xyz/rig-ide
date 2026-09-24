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
}: {
  agent: AgentKind;
  owner: RoomMember | undefined;
  size?: Size;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'border-border-hairline bg-bg-2 relative inline-flex shrink-0 items-center justify-center border',
        AGENT_BOX[size],
        className
      )}
      title={owner ? `${owner.name}'s ${AGENT_NAME[agent]}` : AGENT_NAME[agent]}
    >
      <BrandLogo id={agentLogoId(agent)} size={AGENT_LOGO[size]} />
      <OwnerBadge owner={owner} className={cn('absolute', BADGE[size])} />
    </span>
  );
}
