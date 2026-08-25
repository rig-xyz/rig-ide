import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { relativeTime } from '@renderer/features/chat/session-history';
import { usePulseBriefing } from '@renderer/features/home/use-pulse-briefing';
import { stripRigPrefix } from '@renderer/features/home/summary-segments';

/**
 * The workspace's PEOPLE section: who is in this rig, and one line about
 * what has been happening in it.
 *
 * Two rules learned the hard way. First, the line has to be about THIS rig
 * — the briefing's per-person narration is account-wide and reads as
 * generic filler when you are standing inside one rig, so `perRig` is the
 * only part shown. Second, people and that line stay visually separate: an
 * earlier version stacked the rig summary directly under a member's name
 * and avatar, which read as something that person had said.
 *
 * The briefing is a cached narration the relay regenerates roughly every
 * three hours, and `usePulseBriefing` already forces a fresh one when it
 * ages out. The refresh control is therefore a nudge for impatience, not
 * the mechanism, and stays hidden until the section is hovered.
 */
export function RigPeopleCard({ root, bindingId }: { root: string; bindingId: string | null }) {
  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const { state, refreshing, forceRefresh } = usePulseBriefing();

  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];
  const briefing = state.kind === 'data' ? state.briefing : null;
  const generatedAt = briefing ? Date.parse(briefing.generatedAt) : NaN;
  /**
   * THIS rig's line, not the account-wide personal one. `perPerson` reads
   * "across 3 rigs, CTO reviews, grammar cleanup" — true, and completely
   * generic when you are standing inside one rig looking at its files.
   * `perRig` is the only part of the briefing actually about the rig in
   * front of you, so it is the only part shown here.
   */
  const rigEntry = bindingId
    ? (briefing?.perRig.find((item) => item.bindingId === bindingId) ?? null)
    : null;
  const rigLine = rigEntry ? stripRigPrefix(rigEntry.line, rigEntry.rigName) : null;

  // A rig nobody shares is a rig with nothing to say about people. Local
  // rigs and unreachable-relay states both land here.
  if (members.length === 0) return null;

  const selfId = briefing?.perPerson.find((p) => p.isSelf)?.userId ?? null;
  const ordered = [...members].sort(
    (a, b) => Number(b.userId === selfId) - Number(a.userId === selfId)
  );

  return (
    <div className="group/people mx-4 mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <p className="text-text-muted font-mono text-xs tracking-wide uppercase">People</p>
        {/*
          The briefing refreshes itself when it ages out, so this is a
          nudge, not the mechanism — it stays out of sight until you go
          looking for it.
        */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => void forceRefresh()}
                disabled={refreshing}
                aria-label="Refresh summary"
                className={cn(
                  'text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex size-5 items-center justify-center transition-opacity',
                  refreshing
                    ? 'opacity-100'
                    : 'opacity-0 group-hover/people:opacity-100 focus-visible:opacity-100'
                )}
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
      {/*
        With one member the line reads as that person's own update, so it
        runs inline after their name like a message and costs no extra row.
        With several it cannot: the briefing has no per-person-per-rig
        breakdown, and hanging one rig-level sentence off whichever name
        happens to be first would attribute it to someone who may not have
        done any of it. There it sits below the group, unattributed.
      */}
      {ordered.length === 1 ? (
        <p className="text-text-secondary text-xs leading-relaxed">
          <span className="mr-1.5 inline-flex translate-y-0.5 items-center gap-1.5 align-baseline">
            <IdentityAvatar
              name={ordered[0].name}
              avatarUrl={ordered[0].avatarUrl}
              sizeClassName="size-5"
              textClassName="text-xs"
            />
            <span className="text-text-primary font-medium">
              {ordered[0].userId === selfId ? 'You' : (ordered[0].name ?? ordered[0].email ?? 'Teammate')}
            </span>
          </span>
          <span className="text-text-muted">{rigLine ?? ordered[0].role}</span>
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {ordered.map((member) => (
              <Tooltip key={member.userId}>
                <TooltipTrigger
                  render={
                    <div className="flex min-w-0 items-center gap-1.5">
                      <IdentityAvatar
                        name={member.name}
                        avatarUrl={member.avatarUrl}
                        sizeClassName="size-5"
                        textClassName="text-xs"
                      />
                      <span className="text-text-secondary min-w-0 truncate text-xs">
                        {member.userId === selfId ? 'You' : (member.name ?? member.email ?? 'Teammate')}
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
          {rigLine && <p className="text-text-muted text-xs leading-relaxed">{rigLine}</p>}
        </>
      )}
    </div>
  );
}
