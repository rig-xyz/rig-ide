import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { PULSE_QUERY_KEY } from '@renderer/features/home/briefing-spine';
import { derivePulseSectionState } from '@renderer/features/home/pulse-state';

/**
 * Navigator v3, the workspace's PEOPLE card — Home's `PeopleRail` idea
 * scoped to one rig: who is in this rig, and what has been happening in it,
 * in one line.
 *
 * Two sources, deliberately:
 *   - WHO comes from the rig's own member list (`rig.share.members`), the
 *     same call the Share popover makes, so this is the real membership of
 *     THIS rig rather than everyone the account has ever worked with.
 *   - WHAT comes from the pulse briefing's `perRig` entry for this
 *     binding — the relay's narrated line for this rig specifically. The
 *     briefing has no per-rig-per-person breakdown, so we do NOT invent one
 *     (no fabricated "Hugo edited X" lines): one honest rig-level sentence,
 *     attributed to no one in particular, over per-person fiction.
 *
 * Reads `PULSE_QUERY_KEY` — the same cache entry Home owns, so this is a
 * second reader, not a second fetch. Renders nothing at all when a rig has
 * no members to show (a purely local rig, or the relay is unreachable):
 * absent, not a teaser, matching every other pulse-fed surface here.
 */
export function RigPeopleCard({ root, bindingId }: { root: string; bindingId: string | null }) {
  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => rpc.rig.pulse.get({}),
    staleTime: 60_000,
  });

  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];
  const pulse = derivePulseSectionState({
    isLoading: pulseQuery.isLoading,
    data: pulseQuery.data,
  });
  const line =
    pulse.kind === 'data' && bindingId
      ? (pulse.briefing.perRig.find((entry) => entry.bindingId === bindingId)?.line ?? null)
      : null;

  // A rig nobody shares is a rig with nothing to say about people. Local
  // rigs and unreachable-relay states both land here.
  if (members.length === 0) return null;

  return (
    <div className="border-border-hairline bg-bg-1 rounded-card mx-3 mt-3 flex flex-col gap-2.5 border p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {members.map((member) => (
          <Tooltip key={member.userId}>
            <TooltipTrigger
              render={
                <div className="flex min-w-0 items-center gap-1.5">
                  <IdentityAvatar
                    name={member.name}
                    avatarUrl={member.avatarUrl}
                    sizeClassName="size-5"
                    textClassName="text-[10px]"
                  />
                  <span className="text-text-secondary min-w-0 truncate text-xs">
                    {member.name ?? member.email ?? 'Teammate'}
                  </span>
                </div>
              }
            />
            <TooltipContent side="bottom">
              {member.email ? `${member.email} · ${member.role}` : member.role}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {line && <p className="text-text-muted text-xs leading-relaxed">{line}</p>}
    </div>
  );
}
