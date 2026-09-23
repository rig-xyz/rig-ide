import { describe, expect, it, vi } from 'vitest';
import { RelayRoomSource, type RealtimeProvider } from './relay-room-source';

/**
 * A hand-written fake standing in for `@hocuspocus/provider`'s
 * `HocuspocusProvider` — exactly the "mocked provider" the lane-3 brief
 * calls for. Lets the test fire `connect`/`stateless` events on demand,
 * exactly the way the real provider would after a real WebSocket round
 * trip, without opening one.
 */
class FakeProvider implements RealtimeProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  destroyCalls = 0;
  sent: string[] = [];
  awareness = { setLocalStateField: vi.fn() };
  private handlers: Record<string, Array<(...args: never[]) => void>> = {
    connect: [],
    disconnect: [],
    stateless: [],
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
  sendStateless(payload: string): void {
    this.sent.push(payload);
  }
  on(event: string, cb: (...args: never[]) => void): void {
    this.handlers[event] ??= [];
    this.handlers[event].push(cb);
  }
  off(event: string, cb: (...args: never[]) => void): void {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== cb);
  }
  fire(event: 'connect' | 'disconnect', ...args: never[]): void;
  fire(event: 'stateless', data: { payload: string }): void;
  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers[event] ?? []) (h as (...a: unknown[]) => void)(...args);
  }
}

type Route = { method: string; path: string; respond: () => unknown | Promise<unknown> };

/** A tiny router-style fake `fetch` — routes matched by exact path (including query string). */
function fakeFetch(routes: Route[]): { fetchImpl: typeof fetch; requests: Array<{ method: string; path: string; body?: unknown }> } {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) {
      return new Response(JSON.stringify({ error: `no fake route for ${method} ${path}` }), {
        status: 404,
      });
    }
    const data = await route.respond();
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const BASE = 'https://relay.test';
const BINDING = 'b1';

function membersRoute(): Route {
  return {
    method: 'GET',
    path: `/v1/me/bindings/${BINDING}/members`,
    respond: () => ({
      members: [{ userId: 'u1', name: 'Alice', role: 'owner' }],
    }),
  };
}

describe('RelayRoomSource', () => {
  it('bootstraps members and message history before the realtime connection opens, notifying subscribers', async () => {
    const { fetchImpl, requests } = fakeFetch([
      membersRoute(),
      {
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/messages?latest=50`,
        respond: () => ({
          messages: [
            {
              id: 'm1',
              seq: 1,
              author: { userId: 'u1', name: 'Alice', kind: 'user' },
              kind: 'text',
              body: 'hello room',
              meta: null,
              createdAt: '2026-09-23T09:00:00Z',
            },
          ],
        }),
      },
    ]);

    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => {
        provider = new FakeProvider();
        return provider;
      },
    });

    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    source.play();
    // let the bootstrap's async fetches resolve
    await flush();

    expect(seen).toEqual(['message_created']);
    expect(source.getSnapshot().messages).toHaveLength(1);
    expect(source.getSnapshot().messages[0].body).toBe('hello room');
    expect(source.getSnapshot().members.map((m) => m.id)).toEqual(['u1']);
    expect(provider!.connectCalls).toBe(1);
    expect(requests.some((r) => r.path === `/v1/me/bindings/${BINDING}/members`)).toBe(true);
  });

  it('the first message of kind "session" synthesizes session_started plus its full event backlog', async () => {
    const { fetchImpl } = fakeFetch([
      membersRoute(),
      {
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/messages?latest=50`,
        respond: () => ({
          messages: [
            {
              id: 'm1',
              seq: 1,
              author: { userId: 'u1', name: 'Alice', kind: 'user' },
              kind: 'session',
              body: undefined,
              meta: { runId: 'run1' },
              createdAt: '2026-09-23T09:00:00Z',
            },
          ],
        }),
      },
      {
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/sessions/run1/events?after=0`,
        respond: () => ({
          run: {
            id: 'run1',
            agent: 'claude',
            ownerUserId: 'u1',
            model: 'sonnet-5',
            status: 'running',
            title: 'Do the thing',
            startedAt: '2026-09-23T09:00:00Z',
            endedAt: null,
          },
          events: [{ seq: 1, kind: 'tool_call', payload: { toolCallId: 't1' } }],
        }),
      },
    ]);

    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => new FakeProvider(),
    });

    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    source.play();
    await flush();

    expect(seen).toEqual(['session_started', 'session_event_appended', 'message_created']);
    const snapshot = source.getSnapshot();
    expect(snapshot.sessionMetaByRun.run1.status).toBe('running');
    expect(snapshot.sessionEventsByRun.run1).toHaveLength(1);
    expect(snapshot.sessionEventsByRun.run1[0].kind).toBe('tool_call');
  });

  it('a session_event_appended notification fetches only events after the last known seq', async () => {
    let afterZeroServed = false;
    let afterOneServed = false;
    const { fetchImpl } = fakeFetch([
      membersRoute(),
      {
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/messages?latest=50`,
        respond: () => ({
          messages: [
            {
              id: 'm1',
              seq: 1,
              author: { userId: 'u1', name: 'Alice', kind: 'user' },
              kind: 'session',
              meta: { runId: 'run1' },
              createdAt: '2026-09-23T09:00:00Z',
              body: undefined,
            },
          ],
        }),
      },
      {
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/sessions/run1/events?after=0`,
        respond: () => {
          afterZeroServed = true;
          return {
            run: {
              id: 'run1',
              agent: 'claude',
              ownerUserId: 'u1',
              model: 'sonnet-5',
              status: 'running',
              title: 't',
              startedAt: '2026-09-23T09:00:00Z',
              endedAt: null,
            },
            events: [{ seq: 1, kind: 'tool_call', payload: {} }],
          };
        },
      },
      {
        // catch-up on 'connect' — nothing new yet
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/messages?after=1`,
        respond: () => ({ messages: [] }),
      },
      {
        // Simulates the event not existing yet at connect-time catch-up
        // (empty), then appearing once the stateless notification arrives.
        method: 'GET',
        path: `/v1/me/bindings/${BINDING}/sessions/run1/events?after=1`,
        respond: () => {
          if (!afterOneServed) {
            afterOneServed = true;
            return { run: { id: 'run1' }, events: [] };
          }
          return { run: { id: 'run1' }, events: [{ seq: 2, kind: 'tool_call_update', payload: {} }] };
        },
      },
    ]);

    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => {
        provider = new FakeProvider();
        return provider;
      },
    });

    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    source.play();
    await flush();
    expect(afterZeroServed).toBe(true);

    provider!.fire('connect');
    await flush();
    expect(seen.filter((t) => t === 'session_event_appended')).toHaveLength(1); // no new events yet

    provider!.fire('stateless', { payload: JSON.stringify({ type: 'session_event_appended', runId: 'run1', seq: 2 }) });
    await flush();

    expect(afterOneServed).toBe(true);
    expect(source.getSnapshot().sessionEventsByRun.run1.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('send() posts a text message to the relay', async () => {
    const { fetchImpl, requests } = fakeFetch([
      membersRoute(),
      { method: 'GET', path: `/v1/me/bindings/${BINDING}/messages?latest=50`, respond: () => ({ messages: [] }) },
      { method: 'POST', path: `/v1/me/bindings/${BINDING}/messages`, respond: () => ({ message: {} }) },
    ]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    await source.send('hi everyone');

    const post = requests.find((r) => r.method === 'POST' && r.path === `/v1/me/bindings/${BINDING}/messages`);
    expect(post?.body).toEqual({ body: 'hi everyone', kind: 'text' });
  });

  it('requestOwnAgent() files an agent request targeting the sender', async () => {
    const { fetchImpl, requests } = fakeFetch([
      membersRoute(),
      { method: 'GET', path: `/v1/me/bindings/${BINDING}/messages?latest=50`, respond: () => ({ messages: [] }) },
      {
        method: 'POST',
        path: `/v1/me/bindings/${BINDING}/agent-requests`,
        respond: () => ({ request: {} }),
      },
    ]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    await source.requestOwnAgent('claude', 'summarize the thread', 'm1');

    const post = requests.find((r) => r.path === `/v1/me/bindings/${BINDING}/agent-requests`);
    expect(post?.body).toEqual({
      targetOwnerUserId: 'u1',
      targetAgent: 'claude',
      prompt: 'summarize the thread',
      sourceMessageId: 'm1',
    });
  });

  it('pause()/dispose() disconnect and destroy the underlying provider', async () => {
    const { fetchImpl } = fakeFetch([
      membersRoute(),
      { method: 'GET', path: `/v1/me/bindings/${BINDING}/messages?latest=50`, respond: () => ({ messages: [] }) },
    ]);
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => {
        provider = new FakeProvider();
        return provider;
      },
    });
    source.play();
    await flush();
    source.pause();
    expect(provider!.disconnectCalls).toBe(1);
    source.dispose();
    expect(provider!.destroyCalls).toBe(1);
  });

  it('isDone() is always false and replayAll() is a no-op', async () => {
    const { fetchImpl } = fakeFetch([
      membersRoute(),
      { method: 'GET', path: `/v1/me/bindings/${BINDING}/messages?latest=50`, respond: () => ({ messages: [] }) },
    ]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      relayUrl: BASE,
      wsUrl: 'wss://relay.test/v1/realtime',
      token: 'tok',
      selfUserId: 'u1',
      fetchImpl,
      createProvider: () => new FakeProvider(),
    });
    expect(source.isDone()).toBe(false);
    source.replayAll();
    expect(source.isDone()).toBe(false);
  });
});

/**
 * Drains the chained bootstrap/catch-up awaits, including the real
 * `fetch`/`Response.json()` calls the fake `fetchImpl` still goes through
 * (undici resolves a body read via more than a plain microtask) — a macro-
 * task tick is more reliable here than counting `Promise.resolve()`s.
 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
