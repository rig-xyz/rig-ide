import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { relativeTime } from '@renderer/features/chat/session-history';
import { usePulseBriefing } from '@renderer/features/home/use-pulse-briefing';

/**
 * The workspace's PEOPLE panel — Home's `PeopleRail` layout, scoped to one
 * rig: the same uppercase label, the same avatar + name + narrated line
 * stack, so the two surfaces read as one product rather than two designs.
 *
 * The layout matters for accuracy, not just consistency. An earlier version
 * put the rig's own activity summary directly beneath a single member's
 * name and avatar, which read as if that person had said it. People and
 * their lines belong together; the rig-level summary is a separate
 * statement about the rig and sits apart, with its age attached.
 *
 * Sources, deliberately kept distinct:
 *   - WHO: the rig's own member list (`rig.share.members`), the same call
 *     the Share popover makes, so it is this rig's membership.
 *   - EACH PERSON'S LINE: the pulse briefing's `perPerson` entry for that
 *     user. Account-wide, so it is introduced as such rather than implied
 *     to be about this rig. A member the briefing says nothing about gets
 *     no invented line.
 *   - THE RIG'S LINE: the briefing's `perRig` entry for this binding.
 */
export function RigPeopleCard({ root, bindingId }: { root: string; bindingId: string | null }) {
  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const { state, refreshing } = usePulseBriefing();

  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];
  const briefing = state.kind === 'data' ? state.briefing : null;
  const rigLine = bindingId
    ? (briefing?.perRig.find((item) => item.bindingId === bindingId)?.line ?? null)
    : null;
  const lineFor = (userId: string) => briefing?.perPerson.find((p) => p.userId === userId)?.line ?? null;
  const generatedAt = briefing ? Date.parse(briefing.generatedAt) : NaN;

  // A rig nobody shares is a rig with nothing to say about people. Local
  // rigs and unreachable-relay states both land here.
  if (members.length === 0) return null;

  // "You" first, matching Home.
  const selfId = briefing?.perPerson.find((p) => p.isSelf)?.userId ?? null;
  const ordered = [...members].sort(
    (a, b) => Number(b.userId === selfId) - Number(a.userId === selfId)
  );

  return (
    <div className="border-border-hairline bg-bg-1 rounded-card mx-4 mt-4 flex flex-col gap-3 border p-4">
      <p className="text-text-muted font-mono text-xs tracking-wide uppercase">People</p>
      <div className="flex flex-col gap-3">
        {ordered.map((member) => {
          const line = lineFor(member.userId);
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
      {rigLine && (
        <div className="border-border-hairline flex flex-col gap-1 border-t pt-3">
          <p className="text-text-secondary text-xs leading-relaxed">{rigLine}</p>
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
