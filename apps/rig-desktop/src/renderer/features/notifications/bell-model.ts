/**
 * What the Activity bell lists (Dylan, Home "lighter pass"): only what's for
 * you. Mentions, replies, comments on your own files, invites, approvals and
 * requests to your agents, and someone else's agent finishing work you asked
 * for stay. Your own agents finishing stay only when they finished while you
 * were away (`NotificationService.arrivedWhileAway`). Room messages,
 * reactions, and comments on files that aren't yours are left out and
 * counted in the footer; they're still in each space. Pure.
 */

import type { RigNotification } from '@shared/rig/notifications';

export type BellLeftOut = {
  /** Your own agents finishing while you were here. */
  ownAgents: number;
  messages: number;
  comments: number;
  reactions: number;
};

export type BellGroup = {
  key: string;
  /** Null for an invite: you're not in the space yet. */
  bindingId: string | null;
  spaceName: string | null;
  rows: RigNotification[];
};

export type BellModel = {
  /** By space, the space with the newest row first; rows newest first inside. */
  groups: BellGroup[];
  /** Unread rows kept: the bell's count. */
  unread: number;
  leftOut: BellLeftOut;
};

export type BellContext = { selfUserId: string | null; awayIds: ReadonlySet<string> };

/** Whether one row is for you, and if not, which footer count it goes to. */
export function bellPlace(row: RigNotification, ctx: BellContext): 'keep' | keyof BellLeftOut {
  switch (row.type) {
    case 'message':
      return 'messages';
    case 'reaction':
      return 'reactions';
    case 'comment':
      // A guest commenting through your link is direct; otherwise only your own file.
      return row.tier === 'direct' || (!!ctx.selfUserId && row.fileAuthorUserId === ctx.selfUserId)
        ? 'keep'
        : 'comments';
    case 'agent_finished': {
      const yours = !!ctx.selfUserId && row.actor.userId === ctx.selfUserId;
      return !yours || ctx.awayIds.has(row.id) ? 'keep' : 'ownAgents';
    }
    default:
      return 'keep';
  }
}

export function shapeBell(rows: readonly RigNotification[], ctx: BellContext): BellModel {
  const leftOut: BellLeftOut = { ownAgents: 0, messages: 0, comments: 0, reactions: 0 };
  const groups = new Map<string, BellGroup>();
  let unread = 0;
  for (const row of rows) {
    const place = bellPlace(row, ctx);
    if (place !== 'keep') {
      leftOut[place] += 1;
      continue;
    }
    if (!row.readAt) unread += 1;
    const key = row.bindingId ?? `invite:${row.spaceName ?? row.id}`;
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, bindingId: row.bindingId, spaceName: row.spaceName, rows: [row] });
  }
  return { groups: [...groups.values()], unread, leftOut };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The footer: how many were left out and why, or null when nothing was. */
export function leftOutLine(leftOut: BellLeftOut): string | null {
  const parts = [
    leftOut.ownAgents > 0 &&
      plural(leftOut.ownAgents, 'run of your own agents finishing', 'runs of your own agents finishing') +
        ' while you were here',
    leftOut.messages > 0 && plural(leftOut.messages, 'room message', 'room messages'),
    leftOut.comments > 0 && plural(leftOut.comments, "comment on a file that isn't yours", "comments on files that aren't yours"),
    leftOut.reactions > 0 && plural(leftOut.reactions, 'reaction', 'reactions'),
  ].filter((p): p is string => typeof p === 'string');
  if (parts.length === 0) return null;
  const total = leftOut.ownAgents + leftOut.messages + leftOut.comments + leftOut.reactions;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${total} more ${total === 1 ? 'is' : 'are'} left out: ${list}. They stay in each space.`;
}
