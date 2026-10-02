import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { PULSE_QUERY_KEY } from './briefing-spine';
import { HomeFeedLabel } from './home-feed-label';
import { derivePulseSectionState } from './pulse-state';
import { firstNameKey, shortAge } from './recent-themes-state';

/**
 * Home's PEOPLE, under "Across your spaces today" in the center column: a
 * flat list, one person each, avatar, name, when they last wrote in a Room
 * today, and their one Pulse sentence below. "You" first. The web hub
 * home's Team panel analog (`hub/web`'s `TeamList`), in this app's tokens.
 *
 * Reads the SAME query key `BriefingSpine` owns (`PULSE_QUERY_KEY`), so it
 * is a second reader of the one fetch, not a second fetch. Renders nothing
 * at all when there's no one to show (loading, error, or a briefing with an
 * empty `perPerson`), matching `PulseSection`'s "absent, not a teaser".
 *
 * Pulse carries no time per person; `lastActivity` (from the Room themes of
 * the day, keyed by `firstNameKey`) gives one when it can, and the time is
 * left out when it can't.
 */
export function PeopleRail({ lastActivity }: { lastActivity?: ReadonlyMap<string, string> }) {
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => rpc.rig.pulse.get({}),
    staleTime: 60_000,
  });
  const state = derivePulseSectionState({ isLoading: pulseQuery.isLoading, data: pulseQuery.data });

  if (state.kind !== 'data' || state.briefing.perPerson.length === 0) return null;

  const people = [...state.briefing.perPerson].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
  const now = Date.now();

  return (
    <section className="flex flex-col gap-0.5" data-testid="home-people">
      <div className="pb-1.5">
        <HomeFeedLabel aside="today">People</HomeFeedLabel>
      </div>
      <ul className="flex flex-col">
        {people.map((person) => {
          const key = firstNameKey(person.name);
          const at = key ? lastActivity?.get(key) : undefined;
          return (
            <li
              key={person.userId}
              className="flex items-start gap-3 py-[9px] leading-normal"
              data-testid="home-person"
            >
              <IdentityAvatar
                name={person.name}
                avatarUrl={person.avatarUrl}
                sizeClassName="size-7"
                textClassName="text-2xs"
                className="mt-px"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex min-w-0 items-center justify-between gap-2">
                  <span
                    className="min-w-0 truncate text-sm font-medium text-text-primary"
                    data-testid="home-person-name"
                  >
                    {person.isSelf ? 'You' : (person.name ?? 'Teammate')}
                  </span>
                  {at && (
                    <span
                      className="shrink-0 font-mono text-2xs text-text-muted tabular-nums"
                      data-testid="home-person-age"
                    >
                      {shortAge(at, now)}
                    </span>
                  )}
                </p>
                <p className="text-xs leading-[1.55] text-text-secondary">{person.line}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
