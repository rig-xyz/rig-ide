import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RelayApiError, RoomMemberRow, RoomMessageRow } from '@main/rig/spaces/relay-api';
import type { MessageReaction } from '@shared/spaces/reactions';
import { RelayRoomSource, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';

/** Reactions in the live Room: read with messages, changed by you (at once), and kept current from the relay. */

class FakeProvider implements RealtimeProvider {
  awareness = null;
  private handlers: Record<string, Array<(...args: never[]) => void>> = {};
  connect(): void {}
  disconnect(): void {}
  destroy(): void {}
  sendStateless(): void {}
  on(event: string, cb: (...args: never[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  off(): void {}
  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) (h as (...a: unknown[]) => void)(...args);
  }
}

const MEMBERS: RoomMemberRow[] = [
  {
    userId: 'usr_me',
    clerkUserId: 'clerk_me',
    name: 'Dylan',
    email: null,
    role: 'owner',
    avatarUrl: null,
  },
  {
    userId: 'usr_sam',
    clerkUserId: 'clerk_sam',
    name: 'Sam',
    email: null,
    role: 'viewer',
    avatarUrl: null,
  },
];

function row(id: string, seq: number, reactions: MessageReaction[] = []): RoomMessageRow {
  return {
    id,
    seq,
    author: { userId: 'clerk_sam', name: 'Sam', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: `message ${id}`,
    meta: null,
    createdAt: '2026-09-29T10:00:00Z',
    reactions,
  };
}

const thumbsBySam: MessageReaction = {
  emoji: '👍',
  count: 1,
  reactors: [{ userId: 'clerk_sam', agent: null }],
};

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function open(relay: Partial<RelayRoomClient>, rows: RoomMessageRow[]) {
  let provider: FakeProvider | null = null;
  const client: RelayRoomClient = {
    mintRealtimeTicket: async () =>
      ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () => ok(MEMBERS),
    listMessages: vi.fn(async (_b: string, query: { latest?: number; after?: string }) =>
      ok(query.after ? [] : rows)
    ),
    getSessionEvents: async () => err<RelayApiError>({ kind: 'relay', message: 'none' }),
    postMessage: async () => err<RelayApiError>({ kind: 'relay', message: 'no' }),
    requestOwnAgent: async () => err<RelayApiError>({ kind: 'relay', message: 'no' }),
    ...relay,
  };
  const source = new RelayRoomSource({
    bindingId: 'b1',
    spaceName: 'Growth',
    wsUrl: 'wss://relay.test/v1/realtime',
    selfUserId: 'usr_me',
    relay: client,
    createProvider: () => (provider = new FakeProvider()),
  });
  source.play();
  return { source, client, provider: () => provider! };
}

describe('RelayRoomSource reactions', () => {
  it('reads reactions with the messages, naming reactors by member id', async () => {
    const { source } = open({}, [
      row('m1', 1, [
        {
          emoji: '🎉',
          count: 2,
          reactors: [
            { userId: 'clerk_sam', agent: null },
            { userId: 'clerk_me', agent: 'claude' },
          ],
        },
      ]),
    ]);
    await flush();
    expect(source.getSnapshot().messages[0]!.reactions).toEqual([
      {
        emoji: '🎉',
        count: 2,
        reactors: [
          { userId: 'usr_sam', agent: null },
          { userId: 'usr_me', agent: 'claude' },
        ],
      },
    ]);
  });

  it('react() shows your reaction at once, then settles to what the relay answers', async () => {
    let answer!: (value: ReturnType<typeof ok<MessageReaction[]>>) => void;
    const setReaction = vi.fn(
      () =>
        new Promise<ReturnType<typeof ok<MessageReaction[]>>>((resolve) => {
          answer = resolve;
        })
    );
    const { source } = open({ setReaction }, [row('m1', 1, [thumbsBySam])]);
    await flush();
    const done = source.react('m1', '👍', true);
    expect(source.getSnapshot().messages[0]!.reactions).toEqual([
      {
        emoji: '👍',
        count: 2,
        reactors: [
          { userId: 'usr_sam', agent: null },
          { userId: 'usr_me', agent: null },
        ],
      },
    ]);
    expect(setReaction).toHaveBeenCalledWith('b1', { messageId: 'm1', emoji: '👍', on: true });
    // Meanwhile a third person reacted too: the relay's answer wins.
    answer(
      ok([
        {
          emoji: '👍',
          count: 3,
          reactors: [
            { userId: 'clerk_sam', agent: null },
            { userId: 'clerk_x', agent: null },
            { userId: 'clerk_me', agent: null },
          ],
        },
      ])
    );
    expect(await done).toBe(true);
    expect(source.getSnapshot().messages[0]!.reactions![0]!.count).toBe(3);
  });

  it('react() puts it back when the relay refuses, and sends the stored spelling of the emoji', async () => {
    const setReaction = vi.fn(async () =>
      err<RelayApiError>({ kind: 'relay', status: 409, message: 'too many' })
    );
    const { source } = open({ setReaction }, [row('m1', 1)]);
    await flush();
    expect(await source.react('m1', '❤', true)).toBe(false);
    expect(setReaction).toHaveBeenCalledWith('b1', { messageId: 'm1', emoji: '❤️', on: true });
    expect(source.getSnapshot().messages[0]!.reactions).toBeUndefined();
    // Not an emoji: nothing is sent.
    expect(await source.react('m1', 'lol', true)).toBe(false);
    expect(setReaction).toHaveBeenCalledTimes(1);
  });

  it('removing yours takes the chip away when you were the only one', async () => {
    const mine: MessageReaction = {
      emoji: '👀',
      count: 1,
      reactors: [{ userId: 'clerk_me', agent: null }],
    };
    const setReaction = vi.fn(async () => ok<MessageReaction[]>([]));
    const { source } = open({ setReaction }, [row('m1', 1, [mine])]);
    await flush();
    expect(source.getSnapshot().messages[0]!.reactions).toHaveLength(1);
    await source.react('m1', '👀', false);
    expect(setReaction).toHaveBeenCalledWith('b1', { messageId: 'm1', emoji: '👀', on: false });
    expect(source.getSnapshot().messages[0]!.reactions).toBeUndefined();
  });

  it('a reactions_changed notification re-reads just that message; it never re-reads the messages', async () => {
    const getReactions = vi.fn(async () => ok<MessageReaction[]>([thumbsBySam]));
    const { source, client, provider } = open({ getReactions }, [row('m1', 1), row('m2', 2)]);
    await flush();
    provider().fire('connect');
    await flush();
    const reads = vi.mocked(client.listMessages).mock.calls.length;
    const events: string[] = [];
    source.subscribe((event) => events.push(event.type));
    provider().fire('stateless', {
      payload: JSON.stringify({ type: 'reactions_changed', messageId: 'm2', seq: 2 }),
    });
    await flush();
    expect(getReactions).toHaveBeenCalledWith('b1', 'm2');
    expect(events).toEqual(['reactions_changed']);
    expect(source.getSnapshot().messages.map((m) => m.reactions)).toEqual([
      undefined,
      [{ emoji: '👍', count: 1, reactors: [{ userId: 'usr_sam', agent: null }] }],
    ]);
    expect(vi.mocked(client.listMessages).mock.calls.length).toBe(reads);
  });

  it('after the live connection drops and comes back, catches up on reactions to messages already shown', async () => {
    const listReactionsAfter = vi.fn(async () =>
      ok<Record<string, MessageReaction[]>>({ m2: [thumbsBySam] })
    );
    const { source, provider } = open({ listReactionsAfter }, [
      row('m1', 5, [thumbsBySam]),
      row('m2', 9),
    ]);
    await flush();
    provider().fire('connect');
    await flush();
    // The first connect just loaded them: no second read.
    expect(listReactionsAfter).not.toHaveBeenCalled();
    provider().fire('disconnect');
    provider().fire('connect');
    await flush();
    expect(listReactionsAfter).toHaveBeenCalledWith('b1', 4);
    // m1's reaction was taken back meanwhile (absent from the answer); m2 got one.
    expect(source.getSnapshot().messages.map((m) => m.reactions?.length ?? 0)).toEqual([0, 1]);
  });
});
