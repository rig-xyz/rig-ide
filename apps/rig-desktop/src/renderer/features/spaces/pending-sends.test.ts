import { ok, type Result } from '@emdash/shared';
import type { RelayApiError, RoomMessageRow } from '@main/rig/spaces/relay-api';
import { describe, expect, it } from 'vitest';
import { settlePendingSends, withPendingSends, type PendingSend } from './pending-sends';
import { RelayRoomSource, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';

/**
 * The ghost-message bug: you send, a grey copy shows, then the relay's copy
 * appears ABOVE it, then the grey one goes. The relay's realtime echo (and
 * so the catch-up that reads it) can beat the post's own answer, and the
 * grey copy only knew the relay's id from that answer. Now the post carries
 * the grey copy's id as `meta.clientId`, the relay's copy brings it back,
 * and either arrival replaces the grey copy in the same render.
 */

const BINDING = 'b1';
const ME = 'u1';

function row(id: string, seq: number, body: string, meta: Record<string, unknown> | null = null, author = ME): RoomMessageRow {
  return {
    id,
    seq,
    author: { userId: author, name: author, avatarUrl: null, kind: 'user' },
    kind: 'text',
    body,
    meta,
    createdAt: `2026-09-30T10:00:0${seq}Z`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A relay that stores a post at once (as the real one does) but answers it only when the test says so. */
function openRoom() {
  const stored: RoomMessageRow[] = [row('m1', 1, 'morning', null, 'u2')];
  const answers: Array<(result: Result<RoomMessageRow, RelayApiError>) => void> = [];
  let stateless: ((data: { payload: string }) => void) | null = null;
  let connect: (() => void) | null = null;
  const relay: RelayRoomClient = {
    mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () =>
      ok([
        { userId: ME, clerkUserId: null, name: 'Me', email: null, role: 'owner', avatarUrl: null },
        { userId: 'u2', clerkUserId: null, name: 'Sam', email: null, role: 'member', avatarUrl: null },
      ]),
    listMessages: async (_b, query) => ok(stored.filter((m) => m.seq > Number(query.after ?? 0))),
    getSessionEvents: async () => ({ success: false, error: { kind: 'relay', message: 'none' } }) as never,
    postMessage: (_b, input) => {
      const posted = row(`m${stored.length + 1}`, stored.length + 1, input.body, input.meta ?? null);
      stored.push(posted);
      const answer = deferred<Result<RoomMessageRow, RelayApiError>>();
      answers.push(answer.resolve);
      return answer.promise.then(() => ok(posted));
    },
    requestOwnAgent: async () => ({ success: false, error: { kind: 'relay', message: 'none' } }) as never,
  };
  const provider: RealtimeProvider = {
    connect: () => {},
    disconnect: () => {},
    destroy: () => {},
    sendStateless: () => {},
    on: (event: string, cb: (...args: never[]) => void) => {
      if (event === 'stateless') stateless = cb as never;
      if (event === 'connect') connect = cb as never;
    },
    off: () => {},
    awareness: null,
  };
  const source = new RelayRoomSource({
    bindingId: BINDING,
    spaceName: 'Growth',
    wsUrl: 'wss://relay.test/v1/realtime',
    selfUserId: ME,
    relay,
    createProvider: () => provider,
  });

  // What RoomView does with it: the pending list, settled on every snapshot, drawn on top.
  let pending: PendingSend[] = [];
  source.subscribe(() => {
    pending = settlePendingSends(pending, source.getSnapshot());
  });
  const shown = () => withPendingSends(source.getSnapshot(), pending, ME).messages;

  return {
    source,
    stored,
    async open() {
      source.play();
      await flush();
      connect?.();
      await flush();
    },
    /** Sends like the composer: the pending copy first, then the post carrying its id. */
    send(text: string, localId: string) {
      pending = [...pending, { localId, text, createdAt: new Date().toISOString(), id: null }];
      void source.send(text, undefined, undefined, { clientId: localId }).then((id) => {
        pending = pending.map((send) => (send.localId === localId ? { ...send, id } : send));
      });
    },
    /** The relay's realtime "a message was created" — the Room catches up on it. */
    async echo(id: string, seq: number) {
      stateless?.({ payload: JSON.stringify({ type: 'message_created', id, seq, kind: 'text' }) });
      await flush();
    },
    async answerPost() {
      answers.shift()!(ok(undefined as never));
      await flush();
    },
    shown,
    /** Every row showing `body`: id and whether it's the grey sending copy. */
    copiesOf: (body: string) => shown().filter((m) => m.body === body).map((m) => ({ id: m.id, sending: !!m.sending })),
    pendingCount: () => pending.length,
  };
}

describe('your message while it sends — one bubble, turning solid in place', () => {
  it("the relay's echo lands before the post answers: the grey copy is replaced at once, never shown twice", async () => {
    const room = openRoom();
    await room.open();
    room.send('on my way', 'local-1');
    expect(room.copiesOf('on my way')).toEqual([{ id: 'local-1', sending: true }]);
    // The relay stored it with the client id.
    expect(room.stored.at(-1)!.meta).toEqual({ clientId: 'local-1' });

    await room.echo('m2', 2);
    expect(room.copiesOf('on my way')).toEqual([{ id: 'm2', sending: false }]);
    expect(room.source.getSnapshot().messages.at(-1)).toMatchObject({ id: 'm2', clientId: 'local-1' });
    expect(room.pendingCount()).toBe(0);

    await room.answerPost();
    expect(room.copiesOf('on my way')).toEqual([{ id: 'm2', sending: false }]);
    expect(room.shown().map((m) => m.id)).toEqual(['m1', 'm2']);
    room.source.dispose();
  });

  it('the post answers first: the grey copy waits, then the echo replaces it', async () => {
    const room = openRoom();
    await room.open();
    room.send('on my way', 'local-1');
    await room.answerPost();
    expect(room.copiesOf('on my way')).toEqual([{ id: 'local-1', sending: true }]);

    await room.echo('m2', 2);
    expect(room.copiesOf('on my way')).toEqual([{ id: 'm2', sending: false }]);
    expect(room.pendingCount()).toBe(0);
    room.source.dispose();
  });

  it("a catch-up bringing someone else's message in between keeps one grey copy, last; then the echo replaces it in order", async () => {
    for (const postFirst of [false, true]) {
      const room = openRoom();
      await room.open();
      room.send('on my way', 'local-1'); // stored as m2
      if (postFirst) await room.answerPost();
      // Sam's message is stored after yours, but the catch-up that brings
      // it is the first the Room hears of either.
      room.stored.push(row('m3', 3, 'see you', null, 'u2'));
      await room.echo('m3', 3);
      // Both came in on that one catch-up: yours in its own place, no grey copy.
      expect(room.copiesOf('on my way')).toEqual([{ id: 'm2', sending: false }]);
      expect(room.shown().map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      if (!postFirst) await room.answerPost();
      expect(room.shown().map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      room.source.dispose();
    }
  });

  it("a catch-up that doesn't have yours yet leaves the grey copy, once, after what came in", async () => {
    const room = openRoom();
    await room.open();
    // Sam's message is in the relay before yours is posted.
    room.stored.push(row('m2', 2, 'anyone around?', null, 'u2'));
    room.send('on my way', 'local-1'); // stored as m3
    const mine = room.stored.pop()!; // …but not readable yet (still being written)
    await room.echo('m2', 2);
    expect(room.shown().map((m) => [m.id, !!m.sending])).toEqual([
      ['m1', false],
      ['m2', false],
      ['local-1', true],
    ]);
    room.stored.push(mine);
    await room.echo('m3', 3);
    expect(room.shown().map((m) => [m.id, !!m.sending])).toEqual([
      ['m1', false],
      ['m2', false],
      ['m3', false],
    ]);
    await room.answerPost();
    expect(room.copiesOf('on my way')).toEqual([{ id: 'm3', sending: false }]);
    room.source.dispose();
  });

  it('a thread reply sent to the main column too carries alsoInChannel on its grey copy, the post and the relay copy', async () => {
    const room = openRoom();
    await room.open();
    const replyTo = { id: 'm1', authorId: 'u2', label: 'Sam', excerpt: 'morning' };
    let pending: PendingSend[] = [
      { localId: 'local-1', text: 'on it', replyTo, alsoInChannel: true, createdAt: new Date().toISOString(), id: null },
    ];
    expect(withPendingSends(room.source.getSnapshot(), pending, ME).messages.at(-1)!.meta).toEqual({
      kind: 'text',
      replyTo,
      alsoInChannel: true,
    });
    void room.source.send('on it', replyTo, undefined, { clientId: 'local-1', alsoInChannel: true });
    await flush();
    expect(room.stored.at(-1)!.meta).toEqual({ replyTo, clientId: 'local-1', alsoInChannel: true });
    await room.echo('m2', 2);
    expect(room.source.getSnapshot().messages.at(-1)!.meta).toEqual({ kind: 'text', replyTo, alsoInChannel: true });
    pending = settlePendingSends(pending, room.source.getSnapshot());
    expect(pending).toEqual([]);
    room.source.dispose();
  });

  it('a message from before client ids (no meta.clientId) still settles by its id once the post answers', () => {
    const snapshot = { messages: [{ id: 'm9', seq: 9 }] } as never;
    const pending: PendingSend[] = [{ localId: 'local-1', text: 'x', createdAt: '', id: 'm9' }];
    expect(settlePendingSends(pending, snapshot)).toEqual([]);
    const waiting: PendingSend[] = [{ localId: 'local-2', text: 'y', createdAt: '', id: null }];
    expect(settlePendingSends(waiting, snapshot)).toBe(waiting);
  });
});
