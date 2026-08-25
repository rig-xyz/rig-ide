import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { relativeTime } from '@renderer/features/chat/session-history';
import { usePulseBriefing } from '@renderer/features/home/use-pulse-briefing';

/**
 * The workspace's PEOPLE section: who is in this rig and what each of them
 * has been doing. One section, one shape, the same as Home's `PeopleRail` —
 * label, then a row per person.
 *
 * It used to be four stacked blocks (label, a person, a divider, a rig-level
 * summary with its own timestamp line) which read as several unrelated
 * things in one box. The rig-level summary is gone from here entirely: the
 * files below already say what changed in this rig, and this section is
 * about people. What is left is one idea per row.
 *
 * The briefing is a cached narration the relay regenerates roughly every
 * three hours, so the header carries a refresh control (its age lives in
 * the tooltip). Without one, a summary that reads as current could be hours
 * old with no way to ask for a new one.
 */
export function RigPeopleCard({ root, bindingId }: { root: string; bindingId: string | null }) {
  void bindingId;
  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const { state, refreshing, forceRefresh } = usePulseBriefing();

  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];
  const briefing = state.kind === 'data' ? state.briefing : null;
  const generatedAt = briefing ? Date.parse(briefing.generatedAt) : NaN;

  // A rig nobody shares is a rig with nothing to say about people. Local
  // rigs and unreachable-relay states both land here.
  if (members.length === 0) return null;

  const selfId = briefing?.perPerson.find((p) => p.isSelf)?.userId ?? null;
  const ordered = [...members].sort(
    (a, b) => Number(b.userId === selfId) - Number(a.userId === selfId)
  );

  return (
    <div className="mx-4 mt-4 flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <p className="text-text-muted font-mono text-xs tracking-wide uppercase">People</p>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => void forceRefresh()}
                disabled={refreshing}
                aria-label="Refresh summary"
                className="text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex size-5 items-center justify-center transition-colors disabled:opacity-60"
              >
                <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} strokeWidth={1.5} />
              </button>
            }
          />
          <TooltipContent side="bottom">
            {refreshing
              ? 'Updating'
              : Number.isNaN(generatedAt)
                ? 'Refresh summary'
                : `Updated ${relativeTime(generatedAt, Date.now())} · refresh`}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-2.5">
        {ordered.map((member) => {
          const line = briefing?.perPerson.find((p) => p.userId === member.userId)?.line ?? null;
          return (
            <div key={member.userId} className="flex items-start gap-2.5">
              <IdentityAvatar
                name={member.name}
                avatarUrl={member.avatarUrl}
                sizeClassName="size-6"
                textClassName="text-xs"
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="text-text-primary text-xs font-medium">
                  {member.userId === selfId ? 'You' : (member.name ?? member.email ?? 'Teammate')}
                </p>
                <p className="text-text-muted mt-0.5 text-xs leading-relaxed">
                  {line ?? member.role}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
