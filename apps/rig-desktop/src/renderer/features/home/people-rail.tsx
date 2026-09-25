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
 *
 * Polish round, lane C ("spaces first"): re-skinned onto the SAME floating
 * glass card look every other Home card now shares (design doc — "only
 * re-skinned... Don't redesign its content"), unconditionally rather than
 * only above the `xl` breakpoint, and the header dropped its mono
 * uppercase styling for the plain sentence-case label the rest of Home's
 * headers use now.
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
    <div className="border-border-hairline bg-bg-1 shadow-float flex w-full flex-col gap-2 rounded-card border p-3 text-left">
      <p className="text-text-primary text-sm font-medium">People</p>
      <div className="flex flex-col gap-3">
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
              <p className="text-text-primary text-xs font-medium">
                {person.isSelf ? 'You' : (person.name ?? 'Teammate')}
              </p>
              <p className="text-text-muted mt-0.5 text-xs leading-relaxed">{person.line}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
