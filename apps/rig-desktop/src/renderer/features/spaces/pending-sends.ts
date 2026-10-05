import type { MessageAttachment } from '@shared/rig/attachments';
import { formatClock } from '@renderer/lib/time-format';
import type { RoomMessage, RoomReplyRef, RoomSnapshot } from './types';

/**
 * A message you've sent that the relay hasn't handed back yet. `localId`
 * rides on the post as `meta.clientId` and comes back on the relay's copy,
 * so the copy is recognised whichever arrives first: the post's answer
 * (`id`) or the realtime echo / catch-up.
 */
export type PendingSend = {
  localId: string;
  text: string;
  replyTo?: RoomReplyRef;
  createdAt: string;
  /** The relay's id, once the post has returned. */
  id: string | null;
  /** Shown as cards while the files are copied and the message posted. */
  attachments?: MessageAttachment[];
  /** A thread reply also sent to the main column ("Also send to #space"). */
  alsoInChannel?: boolean;
};

/** Whether the relay's copy of `send` is already among `messages`. */
function delivered(send: PendingSend, messages: readonly RoomMessage[]): boolean {
  return messages.some((m) => m.clientId === send.localId || (send.id !== null && m.id === send.id));
}

/** The pending sends still waiting on the relay (same array when none has landed). */
export function settlePendingSends(pending: PendingSend[], snapshot: RoomSnapshot): PendingSend[] {
  const next = pending.filter((send) => !delivered(send, snapshot.messages));
  return next.length === pending.length ? pending : next;
}

/**
 * The snapshot with your pending messages at the end, so a message shows the
 * moment you send it instead of vanishing until the relay's round trip. Each
 * one drops out in the same render the relay's copy comes in (matched by
 * its client id, or its id once the post has returned), so there's never a
 * second copy. They take the last real `seq`, so the read marker never
 * counts past what the relay has.
 */
export function withPendingSends(snapshot: RoomSnapshot, pending: readonly PendingSend[], selfUserId: string): RoomSnapshot {
  const shown = pending.filter((send) => !delivered(send, snapshot.messages));
  if (shown.length === 0) return snapshot;
  const seq = snapshot.messages.reduce((max, m) => Math.max(max, m.seq), 0);
  return {
    ...snapshot,
    messages: [
      ...snapshot.messages,
      ...shown.map((send) => ({
        id: send.localId,
        clientId: send.localId,
        seq,
        authorId: selfUserId,
        createdAt: send.createdAt,
        time: formatClock(send.createdAt),
        body: send.text || undefined,
        meta: {
          kind: 'text' as const,
          ...(send.replyTo ? { replyTo: send.replyTo } : {}),
          ...(send.attachments?.length ? { attachments: send.attachments, autoBody: !send.text } : {}),
          ...(send.alsoInChannel ? { alsoInChannel: true } : {}),
        },
        sending: true as const,
      })),
    ],
  };
}
