import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { PULSE_QUERY_KEY } from './briefing-spine';
import { derivePulseSectionState } from './pulse-state';

/**
 * Round: HOME RESTRUCTURE — the right region, PEOPLE. The web hub home's
 * Team panel analog (`hub/web`'s `TeamList`), restyled to this app's
 * tokens: avatar/initial (`IdentityAvatar`, reused as-is — no fake
 * presence dots, only what the pulse briefing actually returns), name,
 * their one narrated line. "You" first.
 *
 * Reads the SAME query key `BriefingSpine` owns (`PULSE_QUERY_KEY`) —
 * React Query dedupes the cache entry, so this is not a second fetch, just
 * a second reader of the one already in flight/cached. Renders nothing at
 * all when there's no one to show (loading, error, or a briefing with an
 * empty `perPerson`) — no empty-state chrome, matching `PulseSection`'s
 * own established "absent, not a teaser" precedent.
 */
export function PeopleRail() {
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => rpc.rig.pulse.get({}),
    staleTime: 60_000,
  });
  const state = derivePulseSectionState({ isLoading: pulseQuery.isLoading, data: pulseQuery.data });

  if (state.kind !== 'data' || state.briefing.perPerson.length === 0) return null;

  const people = [...state.briefing.perPerson].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  return (
    // Surface round: `xl:bg-bg-1`/`xl:p-3` live on this component's own
    // root, not a wrapper in `home.tsx` — this component can return `null`
    // above, and a background applied one level out would still paint an
    // empty tinted panel for that case. `px-1` on the header/list below
    // stays (now genuinely nested padding, not redundant) since it also
    // applies below `xl`, where this rail has no surface of its own.
    <div className="xl:bg-bg-1 xl:rounded-card flex w-full flex-col gap-0.5 text-left xl:p-3">
      <p className="text-text-muted px-1 pb-1 font-mono text-xs tracking-wide uppercase">People</p>
      <div className="flex flex-col gap-3 px-1">
        {people.map((person) => (
          <div key={person.userId} className="flex items-start gap-2.5">
            <IdentityAvatar
              name={person.name}
              avatarUrl={person.avatarUrl}
              sizeClassName="size-6"
              textClassName="text-xs"
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <p className="text-text-primary text-[12.5px] font-medium">
                {person.isSelf ? 'You' : (person.name ?? 'Teammate')}
              </p>
              <p className="text-text-muted mt-0.5 text-[12px] leading-relaxed">{person.line}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
