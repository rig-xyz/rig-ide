import type { RoomMember, RoomMessage, RoomSnapshot } from './types';

/**
 * Who someone is on screen, one way everywhere (the Room's transcript, the
 * dock, doc comment mentions): their name and photo, never an id.
 *
 * In order: the space's roster; the relay's own name and photo for them
 * (a message's author, an invite's target, a notice's actor), which still
 * knows someone who left; your own email for yourself; "Former member" for
 * a deleted account; "Someone" only when nothing at all is known. A person
 * without a name set has their email as their name (the relay fills it in).
 */

export const SOMEONE = 'Someone';
export const FORMER_MEMBER = 'Former member';

/** The relay marks a deleted account's id this way (tap `clerk-profiles.ts`). */
const TOMBSTONE_PREFIX = 'former_';

export type PersonIdentity = {
  name: string;
  avatarUrl: string | null;
  /** In the space's roster. */
  member?: RoomMember;
  /** A real name (or email) to draw initials from; false for "Someone" and "Former member". */
  named: boolean;
};

/** What the relay said about someone outside the roster. */
export type SeenPerson = { name?: string | null; avatarUrl?: string | null };

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== SOMEONE ? trimmed : null;
}

export function resolvePerson(
  id: string | null | undefined,
  sources: {
    members: readonly RoomMember[];
    /** The relay's name and photo for them, when it sent one. */
    seen?: SeenPerson | null;
    /** You, with your own email (only your own email is ever known). */
    self?: { id: string; email?: string | null } | null;
  }
): PersonIdentity {
  const member = id ? sources.members.find((m) => m.id === id) : undefined;
  const avatarUrl = member?.avatarUrl ?? sources.seen?.avatarUrl ?? null;
  const base = { avatarUrl, ...(member ? { member } : {}) };
  const name =
    clean(member?.name) ??
    clean(sources.seen?.name) ??
    (id && sources.self?.id === id ? clean(sources.self.email) : null) ??
    // A roster row with no name holds your own email when it's you.
    clean(member?.email);
  if (name && name !== FORMER_MEMBER) return { ...base, name, named: true };
  if (name === FORMER_MEMBER || id?.startsWith(TOMBSTONE_PREFIX))
    return { ...base, name: FORMER_MEMBER, named: false };
  return { ...base, name: SOMEONE, named: false };
}

/** Each author's latest name and photo from the relay, per message list (computed once). */
const seenByMessages = new WeakMap<readonly RoomMessage[], Map<string, SeenPerson>>();

function seenAuthors(messages: readonly RoomMessage[]): Map<string, SeenPerson> {
  let seen = seenByMessages.get(messages);
  if (seen) return seen;
  seen = new Map();
  for (const message of messages) {
    if (message.authorName || message.authorAvatarUrl)
      seen.set(message.authorId, {
        name: message.authorName ?? null,
        avatarUrl: message.authorAvatarUrl ?? null,
      });
  }
  seenByMessages.set(messages, seen);
  return seen;
}

/** Someone in a Room: the roster, then what the relay said on their messages or invites. */
export function personOf(
  snapshot: Pick<RoomSnapshot, 'members' | 'messages'> & Partial<Pick<RoomSnapshot, 'invitesById'>>,
  id: string | null | undefined,
  seen?: SeenPerson | null
): PersonIdentity {
  // (A partial snapshot, such as a preview's, may have no messages.)
  const fromMessages = id && snapshot.messages ? seenAuthors(snapshot.messages).get(id) : undefined;
  const fromInvite = id
    ? Object.values(snapshot.invitesById ?? {}).find((invite) => invite.target?.userId === id)
        ?.target
    : undefined;
  return resolvePerson(id, {
    members: snapshot.members,
    seen: {
      name: seen?.name ?? fromMessages?.name ?? fromInvite?.name ?? null,
      avatarUrl: seen?.avatarUrl ?? fromMessages?.avatarUrl ?? fromInvite?.avatarUrl ?? null,
    },
  });
}
