import type { MessageAttachment } from '@shared/rig/attachments';
import type { AgentKind, MessageMention, RoomReplyRef } from './types';

export type RoomSendExtra = {
  attachments?: MessageAttachment[];
  autoBody?: boolean;
  clientId?: string;
  alsoInChannel?: boolean;
  /** You chose to just send it: the relay's router leaves it alone. */
  route?: 'none';
  /** People tagged by picking them: their ids go in `meta.mentions` (the relay notifies by them), their names as written in `meta.mentionNames`. */
  mentions?: readonly MessageMention[];
};

/**
 * A plain-text Room message as the relay takes it (`postMessage`'s input):
 * the one shape the Room's own send (`RelayRoomSource.send`) and Home's
 * inline reply both post, so a reply from Home is the same message a reply
 * in the Room is.
 */
export function roomTextMessage(
  text: string,
  replyTo?: RoomReplyRef,
  asks?: AgentKind,
  extra?: RoomSendExtra
): { body: string; kind: 'text'; meta?: Record<string, unknown> } {
  const meta = {
    ...(replyTo ? { replyTo } : {}),
    ...(asks ? { asks } : {}),
    ...(extra?.attachments && extra.attachments.length > 0
      ? { attachments: extra.attachments, ...(extra.autoBody ? { autoBody: true } : {}) }
      : {}),
    ...(extra?.clientId ? { clientId: extra.clientId } : {}),
    // A thread reply that also shows in the main column (Threads view); text meta is free-form on the relay.
    ...(extra?.alsoInChannel ? { alsoInChannel: true } : {}),
    ...(extra?.route ? { route: extra.route } : {}),
    ...(extra?.mentions && extra.mentions.length > 0
      ? { mentions: extra.mentions.map((m) => m.id), mentionNames: extra.mentions.map((m) => m.name) }
      : {}),
  };
  return { body: text, kind: 'text', ...(Object.keys(meta).length > 0 ? { meta } : {}) };
}
