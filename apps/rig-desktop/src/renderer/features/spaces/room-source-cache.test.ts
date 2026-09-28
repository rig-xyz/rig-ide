import { ok } from '@emdash/shared';
import type { RoomMessageRow } from '@main/rig/spaces/relay-api';
import { describe, expect, it, vi } from 'vitest';
import { RelayRoomSource, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';
import { RoomSourceCache } from './room-source-cache';

/**
 * The kept-alive Rooms behind other spaces: re-opening one shows it as it
 * was and only catches up; hidden ones go quiet, idle ones close their
 * socket, and nothing of one account outlives a switch or a sign-out.
 */

class FakeProvider implements RealtimeProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  destroyCalls = 0;
  fields: Array<[string, unknown]> = [];
  private handlers: Record<string, Array<(...args: never[]) => void>> = {};
  awareness = {
    setLocalStateField: (field: string, value: unknown) => void this.fields.push([field, value]),
    getStates: () => new Map<number, Record<string, unknown>>(),
    on: () => {},
    off: () => {},
  };
  connect(): void {
    this.connectCalls += 1;
  }
  disconnect(): void {
    this.disconnectCalls += 1;
  }
  destroy(): void {
    this.destroyCalls += 1;
  }
  sendStateless(): void {}
  on(event: string, cb: (...args: never[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  off(): void {}
  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) (h as (...a: unknown[]) => void)(...args);
  }
}

function row(seq: number): RoomMessageRow {
  return {
    id: `m${seq}`,
    seq,
    author: { userId: 'u1', name: 'Alice', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: `message ${seq}`,
    meta: null,
    createdAt: '2026-09-28T09:00:00Z',
  };
}

/** A relay whose log grows like the real one, counting every call by name. */
function relayFor(log: RoomMessageRow[]) {
  const calls: string[] = [];
  const relay: RelayRoomClient = {
    mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () => {
      calls.push('listMembers');
      return ok([{ userId: 'u1', clerkUserId: null, name: 'Alice', email: null, role: 'owner', avatarUrl: null }]);
    },
    listInvites: async () => {
      calls.push('listInvites');
      return ok([]);
    },
    listConnectors: async () => {
      calls.push('listConnectors');
      return ok([]);
    },
    listMessages: async (_b, query) => {
      calls.push(query.after ? `listMessages?after=${query.after}` : 'listMessages?latest');
      const after = query.after ? Number(query.after) : 0;
      return ok(log.filter((m) => m.seq > after));
    },
    getSessionEvents: async () => {
      calls.push('getSessionEvents');
      return ok({ run: null as never, events: [] });
    },
    postMessage: async () => ok(row(999)),
    requestOwnAgent: async () => ok({} as never),
  };
  return { relay, calls };
}

function setup(options: { capacity?: number; idleMs?: number } = {}) {
  const cache = new RoomSourceCache(options);
  const providers = new Map<string, FakeProvider>();
  const relays = new Map<string, ReturnType<typeof relayFor>>();
  const logs = new Map<string, RoomMessageRow[]>();
  const create = (selfUserId: string, bindingId: string) => () => {
    const log = logs.get(bindingId) ?? [row(1)];
    logs.set(bindingId, log);
    const relay = relayFor(log);
    relays.set(bindingId, relay);
    return new RelayRoomSource({
      bindingId,
      spaceName: `#${bindingId}`,
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId,
      relay: relay.relay,
      connectGraceMs: 60_000,
      createProvider: () => {
        const provider = new FakeProvider();
        providers.set(bindingId, provider);
        return provider;
      },
    });
  };
  const open = (bindingId: string, selfUserId = 'u1') => cache.acquire(selfUserId, bindingId, create(selfUserId, bindingId));
  return { cache, open, providers, relays, logs };
}

describe('RoomSourceCache', () => {
  it('re-opening a kept-alive space shows its snapshot at once, with no first-load requests and one catch-up', async () => {
    const { open, providers, relays, logs } = setup();
    const first = open('b1');
    await flush();
    providers.get('b1')!.fire('connect');
    await flush();
    first.release();

    logs.get('b1')!.push(row(2)); // said while you were elsewhere
    const calls = relays.get('b1')!.calls;
    calls.length = 0;
    const again = open('b1');
    expect(again.reused).toBe(true);
    expect(again.source).toBe(first.source);
    expect(again.source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1']); // right away, before any request
    await flush();
    expect(calls).toEqual(['listMessages?after=1']);
    expect(again.source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    again.release();
  });

  it('a hidden Room stops saying you are here or typing; shown again, you are back', async () => {
    const { open, providers } = setup();
    const lease = open('b1');
    await flush();
    const provider = providers.get('b1')!;
    provider.fire('connect');
    lease.source.setTyping(true);
    provider.fields.length = 0;

    lease.release();
    expect(provider.fields).toEqual([
      ['typing', false],
      ['user', null],
    ]);
    lease.source.setTyping(true); // a late keystroke from the view on its way out
    expect(provider.fields.at(-1)).toEqual(['typing', false]);

    open('b1');
    expect(provider.fields.at(-1)).toEqual(['user', { id: 'u1' }]);
  });

  it('a Room hidden past the idle time closes its socket, keeps its snapshot, and reconnects and catches up when shown', async () => {
    const { open, providers, relays, logs } = setup({ idleMs: 20 });
    const lease = open('b1');
    await flush();
    const provider = providers.get('b1')!;
    provider.fire('connect');
    await flush();
    lease.release();
    await wait(40);
    expect(provider.disconnectCalls).toBe(1);
    expect(lease.source.getSnapshot().messages).toHaveLength(1);

    logs.get('b1')!.push(row(2));
    const calls = relays.get('b1')!.calls;
    calls.length = 0;
    open('b1');
    expect(provider.connectCalls).toBe(2); // the same socket, reopened
    provider.fire('connect');
    await flush();
    expect(calls).toEqual(['listMessages?after=1']);
    expect(lease.source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('past capacity, the least recently shown hidden Room is disposed — never the one on screen', async () => {
    const { cache, open, providers } = setup({ capacity: 2 });
    const shown = open('b1'); // stays on screen
    await flush();
    open('b2').release();
    await flush();
    open('b3').release();
    await flush();
    expect(cache.size).toBe(2);
    expect(providers.get('b2')!.destroyCalls).toBe(1);
    expect(providers.get('b1')!.destroyCalls).toBe(0);
    expect(providers.get('b3')!.destroyCalls).toBe(0);
    expect(open('b2').reused).toBe(false); // opens fresh
    shown.release();
  });

  it("another account's Rooms are all disposed at the switch, and never served to it", async () => {
    const { cache, open, providers } = setup();
    open('b1').release();
    open('b2').release();
    await flush();
    cache.rememberConnection({ selfUserId: 'u1', wsUrl: 'wss://relay.test/v1/realtime' });
    expect(cache.peek('b1')).not.toBeNull();

    const other = open('b1', 'u2');
    expect(other.reused).toBe(false);
    expect(providers.get('b2')!.destroyCalls).toBe(1);
    expect(cache.size).toBe(1);

    // Learning who you are now drops whatever is kept for whoever you were.
    cache.rememberConnection({ selfUserId: 'u3', wsUrl: 'wss://relay.test/v1/realtime' });
    expect(cache.size).toBe(0);
    expect(cache.peek('b1')).toBeNull();
  });

  it('sign-out disposes every Room and forgets who you were', async () => {
    const { cache, open, providers } = setup();
    const shown = open('b1');
    open('b2').release();
    await flush();
    cache.rememberConnection({ selfUserId: 'u1', wsUrl: 'wss://relay.test/v1/realtime' });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.connection).toBeNull();
    expect(providers.get('b1')!.destroyCalls).toBe(1);
    expect(providers.get('b2')!.destroyCalls).toBe(1);
    shown.release(); // the view going away afterwards is harmless
  });

  it('a deleted or left space is forgotten', async () => {
    const { cache, open, providers } = setup();
    open('b1').release();
    open('b2').release();
    await flush();
    cache.forget('b1');
    expect(cache.size).toBe(1);
    expect(providers.get('b1')!.destroyCalls).toBe(1);
  });

  it('a lease released twice hides it once', async () => {
    const { open } = setup();
    const lease = open('b1');
    const hide = vi.spyOn(lease.source, 'setShown');
    lease.release();
    lease.release();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
