import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { relativeTime } from '@renderer/features/chat/session-history';
import { usePulseBriefing } from '@renderer/features/home/use-pulse-briefing';

/**
 * The workspace's PEOPLE card — Home's `PeopleRail` idea scoped to one rig:
 * who is in this rig, and what has been happening in it, in one line.
 *
 * Two sources, deliberately:
 *   - WHO comes from the rig's own member list (`rig.share.members`), the
 *     same call the Share popover makes, so this is the real membership of
 *     THIS rig rather than everyone the account has ever worked with.
 *   - WHAT comes from the pulse briefing's `perRig` entry for this binding.
 *     The briefing has no per-rig-per-person breakdown, so we do NOT invent
 *     one (no fabricated "Hugo edited X" lines): one honest rig-level
 *     sentence, attributed to no one in particular, over per-person fiction.
 *
 * `usePulseBriefing` carries the freshness contract — the relay caches a
 * briefing for ~3h and regenerates only on request, so the hook forces a
 * regeneration whenever what it got back is past that. The card states how
 * old the line is rather than presenting it as live.
 */
export function RigPeopleCard({ root, bindingId }: { root: string; bindingId: string | null }) {
  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const { state, refreshing } = usePulseBriefing();

  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];
  const entry =
    state.kind === 'data' && bindingId
      ? (state.briefing.perRig.find((item) => item.bindingId === bindingId) ?? null)
      : null;
  const generatedAt = state.kind === 'data' ? Date.parse(state.briefing.generatedAt) : NaN;

  // A rig nobody shares is a rig with nothing to say about people. Local
  // rigs and unreachable-relay states both land here.
  if (members.length === 0) return null;

  return (
    <div className="border-border-hairline bg-bg-1 rounded-card mx-4 mt-4 flex flex-col gap-3 border p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {members.map((member) => (
          <Tooltip key={member.userId}>
            <TooltipTrigger
              render={
                <div className="flex min-w-0 items-center gap-2">
                  <IdentityAvatar
                    name={member.name}
                    avatarUrl={member.avatarUrl}
                    sizeClassName="size-6"
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
      {entry?.line && (
        <div className="flex flex-col gap-1">
          <p className="text-text-secondary text-xs leading-relaxed">{entry.line}</p>
          {/*
            Says how old the summary is rather than implying it is live: it
            is a cached narration, refreshed when it ages out, and a reader
            deserves to know which.
          */}
          <p className="text-text-muted text-xs">
            {refreshing
              ? 'Updating summary'
              : Number.isNaN(generatedAt)
                ? null
                : `Summary from ${relativeTime(generatedAt, Date.now())}`}
          </p>
        </div>
      )}
    </div>
  );
}
