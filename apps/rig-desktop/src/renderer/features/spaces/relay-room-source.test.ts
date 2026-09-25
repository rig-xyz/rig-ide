import { err, ok, type Result } from '@emdash/shared';
import type {
  AgentRequest,
  RelayApiError,
  RoomMemberRow,
  RoomMessageRow,
  SessionEventRow,
  SessionRun,
} from '@main/rig/spaces/relay-api';
import { describe, expect, it, vi } from 'vitest';
import { RelayRoomSource, type RealtimeProvider, type RelayRoomClient } from './relay-room-source';

/**
 * A hand-written fake standing in for `@hocuspocus/provider`'s
 * `HocuspocusProvider` — exactly the "mocked provider" the lane-3 brief
 * calls for. Lets the test fire `connect`/`stateless` events on demand,
 * exactly the way the real provider would after a real WebSocket round
 * trip, without opening one. Records every `getToken()` call so a test can
 * prove the ticket path is exercised (once per connect, mirroring how the
 * real provider re-authenticates on every reconnect).
 */
class FakeProvider implements RealtimeProvider {
  connectCalls = 0;
  disconnectCalls = 0;
  destroyCalls = 0;
  sent: string[] = [];
  awarenessStates = new Map<number, Record<string, unknown>>();
  private awarenessHandlers: Array<() => void> = [];
  awareness = {
    setLocalStateField: vi.fn(),
    getStates: () => this.awarenessStates,
    on: (_event: 'change', cb: () => void) => void this.awarenessHandlers.push(cb),
    off: (_event: 'change', cb: () => void) => {
      this.awarenessHandlers = this.awarenessHandlers.filter((h) => h !== cb);
    },
  };
  /** Replaces all clients' awareness states and fires 'change'. */
  setAwareness(states: Array<Record<string, unknown>>): void {
    this.awarenessStates = new Map(states.map((state, i) => [i + 1, state]));
    for (const h of this.awarenessHandlers) h();
  }
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

const BINDING = 'b1';

function member(overrides: Partial<RoomMemberRow> = {}): RoomMemberRow {
  return { userId: 'u1', clerkUserId: null, name: 'Alice', email: null, role: 'owner', avatarUrl: null, ...overrides };
}

function message(overrides: Partial<RoomMessageRow> = {}): RoomMessageRow {
  return {
    id: 'm1',
    seq: 1,
    author: { userId: 'u1', name: 'Alice', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: 'hello room',
    meta: null,
    createdAt: '2026-09-23T09:00:00Z',
    ...overrides,
  };
}

function run(overrides: Partial<SessionRun> = {}): SessionRun {
  return {
    id: 'run1',
    bindingId: BINDING,
    ownerUserId: 'u1',
    agent: 'claude',
    model: 'sonnet-5',
    status: 'running',
    title: 'Do the thing',
    commands: null,
    startedAt: '2026-09-23T09:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

/**
 * A fully controllable fake `RelayRoomClient` — the seam this class is
 * built to be tested against, now that every relay call is proxied through
 * main instead of a direct `fetch`. Each method reads from a queue of
 * canned responses (defaulting to an empty/ok result) so a test only has to
 * set up the calls it cares about.
 */
function makeFakeRelay(overrides: Partial<RelayRoomClient> = {}) {
  const posted: Array<{ bindingId: string; body: string; kind?: string }> = [];
  const agentRequests: Array<{ bindingId: string; input: unknown }> = [];
  const ticketMints: string[] = [];
  let members: RoomMemberRow[] = [member()];
  let messagesQueue: RoomMessageRow[][] = [[]];
  const runsById = new Map<string, { run: SessionRun; events: SessionEventRow[] }>();
  let ticket = { ticket: 'ticket-1', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };

  const relay: RelayRoomClient = {
    async mintRealtimeTicket(bindingId) {
      ticketMints.push(bindingId);
      return ok(ticket);
    },
    async listMembers() {
      return ok(members);
    },
    async listMessages() {
      return ok(messagesQueue.shift() ?? []);
    },
    async getSessionEvents(_bindingId, runId, after = 0) {
      const entry = runsById.get(runId);
      if (!entry) return err<RelayApiError>({ kind: 'relay', message: 'not found' });
      return ok({ run: entry.run, events: entry.events.filter((e) => e.seq > after) });
    },
    async postMessage(bindingId, input) {
      posted.push({ bindingId, body: input.body, kind: input.kind });
      return ok(message({ id: 'posted-1', seq: 999, body: input.body }));
    },
    async requestOwnAgent(bindingId, input) {
      agentRequests.push({ bindingId, input });
      return ok({
        id: 'req1',
        bindingId,
        targetOwnerUserId: input.targetOwnerUserId,
        targetAgent: input.targetAgent,
        requestedByUserId: input.targetOwnerUserId,
        sourceMessageId: input.sourceMessageId ?? null,
        prompt: input.prompt,
        status: 'queued',
        claimedByDeviceId: null,
        claimedAt: null,
        runId: null,
        createdAt: '',
        updatedAt: '',
      } satisfies AgentRequest);
    },
    ...overrides,
  };

  return {
    relay,
    posted,
    agentRequests,
    ticketMints,
    setMembers: (rows: RoomMemberRow[]) => (members = rows),
    /** Each call to `listMessages` shifts one entry off this queue (defaults to `[]`). */
    queueMessages: (...batches: RoomMessageRow[][]) => (messagesQueue = batches),
    setRun: (runId: string, r: SessionRun, events: SessionEventRow[]) =>
      runsById.set(runId, { run: r, events }),
    appendEvents: (runId: string, events: SessionEventRow[]) => {
      const entry = runsById.get(runId);
      if (entry) entry.events.push(...events);
    },
    setTicket: (t: { ticket: string; expiresAt: string }) => (ticket = t),
  };
}

function sessionEvent(overrides: Partial<SessionEventRow> = {}): SessionEventRow {
  return {
    runId: 'run1',
    seq: 1,
    kind: 'tool_call',
    payload: {},
    bytes: 0,
    truncated: false,
    originalBytes: null,
    createdAt: '',
    ...overrides,
  };
}

describe('RelayRoomSource', () => {
  it('bootstraps members and message history before the realtime connection opens, notifying subscribers', async () => {
    const fake = makeFakeRelay();
    fake.setMembers([member()]);
    fake.queueMessages([message()]);

    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => {
        provider = new FakeProvider();
        return provider;
      },
    });

    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    source.play();
    await flush();

    expect(seen).toEqual(['message_created']);
    expect(source.getSnapshot().messages).toHaveLength(1);
    expect(source.getSnapshot().messages[0].body).toBe('hello room');
    expect(source.getSnapshot().members.map((m) => m.id)).toEqual(['u1']);
    expect(provider!.connectCalls).toBe(1);
  });

  it('reports its live connection: connecting, then online, offline when cut, online again', async () => {
    const fake = makeFakeRelay();
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => {
        provider = new FakeProvider();
        return provider;
      },
    });
    expect(source.getSnapshot().connection).toBe('connecting');
    source.play();
    await flush();
    provider!.fire('connect');
    expect(source.getSnapshot().connection).toBe('online');
    provider!.fire('disconnect');
    expect(source.getSnapshot().connection).toBe('offline');
    provider!.fire('connect');
    expect(source.getSnapshot().connection).toBe('online');
  });

  it("offers the viewer's own claude and codex, so @claude/@codex can be tagged", () => {
    const fake = makeFakeRelay();
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    expect(source.getSnapshot().agents.map((a) => [a.agent, a.owner])).toEqual([
      ['claude', 'u1'],
      ['codex', 'u1'],
    ]);
  });

  it('maps Clerk-id message authors back to member user ids, and names unnamed members by email', async () => {
    const fake = makeFakeRelay();
    fake.setMembers([member({ userId: 'usr_1', clerkUserId: 'clerk_1', name: null, email: 'dylan@play.local' })]);
    fake.queueMessages([message({ author: { userId: 'clerk_1', name: null, avatarUrl: null, kind: 'user' } })]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'usr_1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();

    expect(source.getSnapshot().messages[0].authorId).toBe('usr_1');
    expect(source.getSnapshot().members[0]).toMatchObject({ id: 'usr_1', name: 'dylan', initial: 'D' });
  });

  it('keeps doc comments in the room as comment lines tied to their file and passage', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([
      message({ id: 'c1', seq: 1, body: 'Why the drop?', path: 'signups.md', parentId: null, quote: '| W2 | 34 |' }),
      message({
        id: 'c2',
        seq: 2,
        body: 'A tracking bug, fixed by Alice.',
        path: 'signups.md',
        parentId: 'c1',
        quote: null,
        author: { userId: 'u1', name: null, avatarUrl: null, kind: 'agent' },
        meta: { agent: 'Claude Code' },
      }),
    ]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();

    const [first, reply] = source.getSnapshot().messages;
    expect(first.meta).toEqual({ kind: 'comment_mirror', commentId: 'c1', path: 'signups.md', quote: '| W2 | 34 |' });
    expect(reply.meta).toEqual({
      kind: 'comment_mirror',
      commentId: 'c1',
      path: 'signups.md',
      quote: '| W2 | 34 |',
      isReply: true,
      replyFromAgent: 'claude',
    });
  });

  it('derives who is here and who is typing from awareness, never showing yourself typing', async () => {
    const fake = makeFakeRelay();
    fake.setMembers([member({ userId: 'u1' }), member({ userId: 'u2', name: 'Sam' }), member({ userId: 'u3', name: 'Carol' })]);
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => (provider = new FakeProvider()),
    });
    source.play();
    await flush();
    expect(provider!.awareness.setLocalStateField).toHaveBeenCalledWith('user', { id: 'u1' });

    provider!.setAwareness([{ user: { id: 'u1' }, typing: true }, { user: { id: 'u2' }, typing: true }]);
    const snap = source.getSnapshot();
    expect(snap.members.map((m) => [m.id, m.online])).toEqual([
      ['u1', true],
      ['u2', true],
      ['u3', false],
    ]);
    expect(snap.typingUserIds).toEqual(['u2']);

    provider!.setAwareness([{ user: { id: 'u1' } }]);
    expect(source.getSnapshot().typingUserIds).toEqual([]);
    expect(source.getSnapshot().members.find((m) => m.id === 'u2')?.online).toBe(false);
  });

  it("lists the space's own skills for the / palette", async () => {
    const fake = makeFakeRelay();
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: { ...fake.relay, listSkills: async () => [{ cmd: '/weekly-report', name: 'weekly-report', desc: 'Summarise' }] },
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    expect(source.getSnapshot().skills).toEqual([
      { cmd: '/weekly-report', name: 'weekly-report', desc: 'Summarise', addedBy: '' },
    ]);
  });

  it('fills invite cards from the relay: email, role, and joined once a member has that email', async () => {
    const fake = makeFakeRelay();
    fake.setMembers([
      member({ userId: 'u1', name: 'Dylan', email: 'dylan@play.local' }),
      member({ userId: 'u2', name: 'Sam', email: 'sam@play.local' }),
    ]);
    fake.queueMessages([
      message({ id: 'i1', seq: 1, kind: 'invite', body: 'invited sam@play.local', meta: { inviteId: 'inv_sam' } }),
      message({ id: 'i2', seq: 2, kind: 'invite', body: 'invited carol@play.local', meta: { inviteId: 'inv_carol' } }),
    ]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: {
        ...fake.relay,
        listInvites: async () => ({
          success: true,
          data: [
            { id: 'inv_sam', inviterUserId: 'u1', email: 'sam@play.local', role: 'editor', revoked: false },
            { id: 'inv_carol', inviterUserId: 'u2', email: 'carol@play.local', role: 'viewer', revoked: false },
          ],
        }),
      },
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    const invites = source.getSnapshot().invitesById;
    expect(invites.inv_sam).toMatchObject({ email: 'sam@play.local', role: 'editor', status: 'joined', by: 'u1' });
    expect(invites.inv_carol).toMatchObject({ email: 'carol@play.local', role: 'viewer', status: 'sent', by: 'u2' });
  });

  it('opens the connection with a ticket minted through the relay client, not a static token', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([]);
    let gotToken: string | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: async (options) => {
        gotToken = await options.getToken();
        return new FakeProvider();
      },
    });

    source.play();
    await flush();

    expect(fake.ticketMints).toEqual([BINDING]);
    expect(gotToken).toBe('ticket-1');
  });

  it('the first message of kind "session" synthesizes session_started plus its full event backlog', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([message({ kind: 'session', body: '', meta: { runId: 'run1' } })]);
    fake.setRun('run1', run(), [sessionEvent({ seq: 1, kind: 'tool_call', payload: { toolCallId: 't1' } })]);

    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
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
    const fake = makeFakeRelay();
    fake.queueMessages(
      [message({ kind: 'session', body: '', meta: { runId: 'run1' } })],
      [] // connect-time catch-up: nothing new
    );
    fake.setRun('run1', run(), [sessionEvent({ seq: 1 })]);

    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => {
        provider = new FakeProvider();
        return provider;
      },
    });

    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    source.play();
    await flush();

    provider!.fire('connect');
    await flush();
    expect(seen.filter((t) => t === 'session_event_appended')).toHaveLength(1); // no new events yet

    fake.appendEvents('run1', [sessionEvent({ seq: 2, kind: 'tool_call_update' })]);
    provider!.fire('stateless', { payload: JSON.stringify({ type: 'session_event_appended', runId: 'run1', seq: 2 }) });
    await flush();

    expect(source.getSnapshot().sessionEventsByRun.run1.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('send() posts a text message through the relay client', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    const id = await source.send('hi everyone');

    expect(fake.posted).toEqual([{ bindingId: BINDING, body: 'hi everyone', kind: 'text' }]);
    expect(id).toBe('posted-1');
  });

  it('requestOwnAgent() files an agent request targeting the sender', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    await source.requestOwnAgent('claude', 'summarize the thread', 'm1');

    expect(fake.agentRequests).toEqual([
      {
        bindingId: BINDING,
        input: {
          targetOwnerUserId: 'u1',
          targetAgent: 'claude',
          prompt: 'summarize the thread',
          sourceMessageId: 'm1',
        },
      },
    ]);
  });

  it('pause()/dispose() disconnect and destroy the underlying provider', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([]);
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
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
    const fake = makeFakeRelay();
    fake.queueMessages([]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    expect(source.isDone()).toBe(false);
    source.replayAll();
    expect(source.isDone()).toBe(false);
  });
});

describe('RelayRoomSource — connectors (connectors-spec.md)', () => {
  it("bootstraps the space's connectors from the relay, enriched with this device's own connection state", async () => {
    const fake = makeFakeRelay({
      listConnectors: async () => ok([{ connectorId: 'linear', addedBy: 'u1', addedAt: '2026-09-24T00:00:00Z' }]),
    });
    const connections = { list: vi.fn().mockResolvedValue([{ id: 'linear', state: 'connected' }]) };
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      connections,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    expect(source.getSnapshot().connectors).toEqual([{ id: 'linear', name: 'Linear', addedBy: 'u1', mine: 'connected' }]);
  });

  it('refetches the connector list when a connectors_added system message arrives', async () => {
    let listCalls = 0;
    const fake = makeFakeRelay({
      listConnectors: async () => {
        listCalls += 1;
        return ok(listCalls === 1 ? [] : [{ connectorId: 'notion', addedBy: 'u1', addedAt: '' }]);
      },
    });
    fake.queueMessages([
      message({
        id: 'm2',
        seq: 2,
        kind: 'system',
        body: 'Dylan added Notion',
        meta: { event: 'connectors_added', connectorIds: ['notion'] },
      }),
    ]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    // Bootstrap's own refresh (empty) plus one more triggered by the
    // system message — the final snapshot reflects that second fetch.
    expect(listCalls).toBe(2);
    expect(source.getSnapshot().connectors.map((c) => c.id)).toEqual(['notion']);
  });

  it('adds and removes a connector through the relay, re-syncing the list afterward', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    let listCalls = 0;
    const fake = makeFakeRelay({
      listConnectors: async () => {
        listCalls += 1;
        return ok(listCalls === 1 ? [] : [{ connectorId: 'linear', addedBy: 'u1', addedAt: '' }]);
      },
      addConnector: async (_bindingId, connectorId) => {
        added.push(connectorId);
        return ok({ connectorId, addedBy: 'u1', addedAt: '' });
      },
      removeConnector: async (_bindingId, connectorId) => {
        removed.push(connectorId);
        return ok(undefined);
      },
    });
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();

    expect(await source.addConnector('linear')).toEqual({ ok: true });
    expect(added).toEqual(['linear']);
    expect(source.getSnapshot().connectors.map((c) => c.id)).toEqual(['linear']);

    expect(await source.removeConnector('linear')).toEqual({ ok: true });
    expect(removed).toEqual(['linear']);
  });

  it("surfaces a write it can't make (403 from the relay) instead of throwing", async () => {
    const fake = makeFakeRelay({
      addConnector: async () => err<RelayApiError>({ kind: 'relay', message: 'Forbidden' }),
      removeConnector: async () => err<RelayApiError>({ kind: 'relay', message: 'Forbidden' }),
    });
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    expect(await source.addConnector('linear')).toEqual({ ok: false, message: 'Forbidden' });
    expect(await source.removeConnector('linear')).toEqual({ ok: false, message: 'Forbidden' });
  });

  it("refreshConnections re-merges just this device's own state, without hitting the relay's connector list again", async () => {
    let listCalls = 0;
    const fake = makeFakeRelay({
      listConnectors: async () => {
        listCalls += 1;
        return ok([{ connectorId: 'linear', addedBy: 'u1', addedAt: '' }]);
      },
    });
    let state: 'connected' | 'not_connected' | 'expired' = 'not_connected';
    const connections = { list: vi.fn(async () => [{ id: 'linear' as const, state }]) };
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      connections,
      createProvider: () => new FakeProvider(),
    });
    source.play();
    await flush();
    expect(source.getSnapshot().connectors[0]!.mine).toBe('not_connected');
    expect(listCalls).toBe(1);

    state = 'connected';
    await source.refreshConnections();
    expect(source.getSnapshot().connectors[0]!.mine).toBe('connected');
    expect(listCalls).toBe(1); // refreshConnections never re-hits listConnectors, only the local connections client
  });
});

/**
 * Drains the chained bootstrap/catch-up awaits — a macro-task tick is more
 * reliable here than counting `Promise.resolve()`s given how many awaits
 * chain together (bootstrap -> ticket mint -> provider connect -> catch-up).
 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
