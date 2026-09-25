import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useRef } from 'react';
import type { RoomMember } from './types';

/**
 * Everywhere else a space's people show up (the top bar's faces, the
 * Details panel's People row, the share popover, Home's faces) is a cached
 * relay read; the Room's roster is the live one (a join arrives as a room
 * message, or by the source's fallback poll). When the roster changes, this
 * refreshes those reads so every surface shows the same people.
 */

/** The cached reads that list a space's people. Prefixes: any root's members/invites (only mounted queries refetch). */
export function memberQueryKeys(bindingId: string): ReadonlyArray<readonly unknown[]> {
  return [
    ['rig', 'share', 'members'],
    ['rig', 'share', 'invites'],
    ['rig', 'spacesConnection', 'listMembers', bindingId],
  ];
}

/** Who is on the roster, order-independent — `''` for "not known yet" (an empty or not-yet-loaded Room). */
export function rosterKey(members: readonly Pick<RoomMember, 'id'>[]): string {
  return members.map((m) => m.id).sort().join(',');
}

/**
 * Refreshes the member reads whenever `members` (the live roster) changes
 * after it's first known. `enabled` is false for the scripted demo. Reads
 * the query client from context rather than `useQueryClient()`, which
 * throws in a host with no client.
 */
export function useRefreshMemberReadsOnRosterChange(
  members: readonly Pick<RoomMember, 'id'>[] | null,
  bindingId: string,
  enabled: boolean
): void {
  const queryClient = useContext(QueryClientContext);
  const key = enabled && members ? rosterKey(members) : '';
  const lastKeyRef = useRef('');
  useEffect(() => {
    if (!key) return;
    const previous = lastKeyRef.current;
    lastKeyRef.current = key;
    if (!previous || previous === key || !queryClient) return;
    for (const queryKey of memberQueryKeys(bindingId)) void queryClient.invalidateQueries({ queryKey });
  }, [key, bindingId, queryClient]);
}
