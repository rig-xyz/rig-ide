/**
 * Faces on Home's space rows and topic lines only when they are the reason
 * the row is worth a look (Dylan, Home "lighter pass"): the person mentioned
 * or replied to you there, has unread messages there, or their agent is
 * running there. Anyone else gets no face; the People column is where
 * everyone is listed. Pure, like `space-status-state.ts`.
 */

import type { RigNotification } from '@shared/rig/notifications';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { firstNameKey, themeFaces, type TopicMark } from './recent-themes-state';

export type FaceReasonKind = 'mentioned' | 'unread' | 'running';

export type FaceReason = {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  kind: FaceReasonKind;
};

/** Faces on a row before the rest are left out. */
export const REASON_FACES_MAX = 3;

type Member = { userId: string; name: string | null; email?: string | null; avatarUrl: string | null };

/**
 * One space's faces, strongest reason first (mentioned, then unread, then
 * running), each person once and never you:
 *   - `mentions`: your unread mentions and replies in this space;
 *   - unread: authors of the space's recent messages past `cursor`, their
 *     agents' turns included (an agent's turn is stamped with its owner). A
 *     share-link guest is stamped with the link's creator, so guests are
 *     left out. A relay that sends no recent messages, or no cursor, leaves
 *     only the mentions;
 *   - running: the owners of runs going on in the space now.
 * Names and pictures come from the space's members, else what the row says.
 */
export function deriveFaceReasons(input: {
  selfUserId: string | null;
  mentions: readonly Pick<RigNotification, 'actor'>[];
  status: RigSpaceStatus | undefined;
  cursor: number | null;
  members: readonly Member[];
}): FaceReason[] {
  const { selfUserId, status, cursor } = input;
  const members = new Map(input.members.map((m) => [m.userId, m]));
  const out: FaceReason[] = [];
  const add = (userId: string | null | undefined, kind: FaceReasonKind, fallbackName: string | null) => {
    if (!userId || userId === selfUserId || out.some((f) => f.userId === userId)) return;
    const member = members.get(userId);
    out.push({
      userId,
      name: member?.name ?? member?.email ?? fallbackName,
      avatarUrl: member?.avatarUrl ?? null,
      kind,
    });
  };
  for (const n of input.mentions) {
    if (n.actor.kind === 'guest') continue;
    add(n.actor.userId, 'mentioned', n.actor.kind === 'user' ? n.actor.name : null);
  }
  if (cursor !== null) {
    const unread = (status?.recentMessages ?? []).filter((m) => m.seq > cursor && m.authorKind !== 'guest');
    for (const m of [...unread].reverse()) add(m.authorUserId, 'unread', null);
  }
  for (const run of status?.running ?? []) add(run.ownerUserId, 'running', run.ownerName ?? null);
  return out;
}

/** Your unread mentions and replies, by space, newest first: the rows a "mentioned" face comes from. */
export function unreadMentionsBySpace(rows: readonly RigNotification[]): Map<string, RigNotification[]> {
  const out = new Map<string, RigNotification[]>();
  for (const row of rows) {
    if (row.readAt || !row.bindingId || (row.type !== 'mention' && row.type !== 'reply')) continue;
    out.set(row.bindingId, [...(out.get(row.bindingId) ?? []), row]);
  }
  return out;
}

/**
 * A topic line's faces: the people the topic names who are a reason in its
 * space. A topic you've already read keeps only the faces of agents running
 * now, since what's unread or for you isn't in it.
 */
export function topicFaceReasons(
  people: readonly string[],
  reasons: readonly FaceReason[],
  mark: TopicMark | undefined
): Array<{ name: string; reason: FaceReason }> {
  const out: Array<{ name: string; reason: FaceReason }> = [];
  for (const name of themeFaces(people)) {
    const key = firstNameKey(name);
    const reason = reasons.find(
      (r) => firstNameKey(r.name) === key && (mark?.kind !== 'seen' || r.kind === 'running')
    );
    if (key && reason) out.push({ name, reason });
  }
  return out;
}

/** What a face's tooltip says it's there for. */
export function faceReasonLabel(reason: Pick<FaceReason, 'name' | 'kind'>): string {
  const who = reason.name ?? 'Someone';
  switch (reason.kind) {
    case 'mentioned':
      return `${who} mentioned you`;
    case 'unread':
      return `New messages from ${who}`;
    case 'running':
      return `${who}'s agent is working here`;
  }
}
