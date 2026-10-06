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
import { buildRoomFeed, reduceRoom } from './fixtures/room-feed';
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
    expect(source.getSnapshot().members[0]).toMatchObject({ id: 'usr_1', name: 'dylan@play.local', initial: 'D' });
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

  it('carries a comment thread\'s saved pin number onto its line and its replies', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([
      message({ id: 'c1', seq: 1, body: 'Why the drop?', path: 'signups.md', parentId: null, quote: 'W2', meta: { pin: 3 } }),
      message({ id: 'c2', seq: 2, body: 'Tracking bug.', path: 'signups.md', parentId: 'c1', quote: null }),
      message({ id: 'c3', seq: 3, body: 'Older, no number.', path: 'signups.md', parentId: null, quote: 'W3' }),
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

    const [first, reply, older] = source.getSnapshot().messages;
    expect(first.meta).toMatchObject({ kind: 'comment_mirror', pin: 3 });
    expect(reply.meta).toMatchObject({ kind: 'comment_mirror', isReply: true, pin: 3 });
    expect(older.meta).not.toHaveProperty('pin');
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

  it('the first message of kind "session" shows at once, then its run lands with its full event backlog in one step', async () => {
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

    // The message is announced first (its card a placeholder meanwhile),
    // then the run's header and whole log together, as one event.
    expect(seen).toEqual(['message_created', 'session_log_loaded']);
    const snapshot = source.getSnapshot();
    expect(snapshot.runsLoading).toEqual({});
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
    // Bootstrap already folded run1's one event in silently (no separate
    // notification — see the batching test below); the connect-time
    // catch-up finds nothing newer than the seq it already has.
    expect(seen.filter((t) => t === 'session_event_appended')).toHaveLength(0); // no new events yet

    fake.appendEvents('run1', [sessionEvent({ seq: 2, kind: 'tool_call_update' })]);
    provider!.fire('stateless', { payload: JSON.stringify({ type: 'session_event_appended', runId: 'run1', seq: 2 }) });
    await flush();

    expect(source.getSnapshot().sessionEventsByRun.run1.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("a member_joined system message re-reads the roster first, so the join row is the new member's, not a raw Clerk id", async () => {
    const fake = makeFakeRelay();
    fake.setMembers([member()]);
    fake.queueMessages(
      [message()],
      [], // connect-time catch-up: nothing new
      [
        message({
          id: 'm2',
          seq: 2,
          kind: 'system',
          body: 'joined the space',
          author: { userId: 'clerk_sam', name: 'Sam', avatarUrl: null, kind: 'user' },
          meta: { event: 'member_joined', userId: 'u-sam' },
        }),
      ]
    );
    let listMembersCalls = 0;
    const listMembers = fake.relay.listMembers.bind(fake.relay);
    fake.relay.listMembers = async (bindingId) => {
      listMembersCalls += 1;
      return listMembers(bindingId);
    };

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
    provider!.fire('connect');
    await flush();
    expect(listMembersCalls).toBe(1);

    fake.setMembers([member(), member({ userId: 'u-sam', clerkUserId: 'clerk_sam', name: 'Sam', role: 'editor' })]);
    provider!.fire('stateless', { payload: JSON.stringify({ type: 'message_created', id: 'm2', seq: 2, kind: 'system' }) });
    await flush();

    expect(listMembersCalls).toBe(2);
    const snapshot = source.getSnapshot();
    expect(snapshot.members.map((m) => m.id)).toEqual(['u1', 'u-sam']);
    const joined = snapshot.messages.find((m) => m.id === 'm2');
    expect(joined?.authorId).toBe('u-sam');
    expect(joined?.meta).toEqual({ kind: 'system', event: 'member_joined' });
  });

  it('shows the messages first, then loads the runs newest-first, bounded, announcing them in batches (Calm Room open)', async () => {
    const fake = makeFakeRelay();
    const runIds = ['run1', 'run2', 'run3', 'run4', 'run5', 'run6', 'run7', 'run8'];
    fake.queueMessages(
      runIds.map((id, i) => message({ id: `m${i}`, seq: i + 1, kind: 'session', body: '', meta: { runId: id } }))
    );

    // A `getSessionEvents` that never resolves on its own — the test drives
    // each call's resolution by hand, so it can prove how many are in
    // flight together rather than trusting timing.
    const pending = new Map<string, () => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const relay: RelayRoomClient = {
      ...fake.relay,
      async getSessionEvents(_bindingId, runId) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => pending.set(runId, () => resolve()));
        inFlight -= 1;
        return ok({ run: run({ id: runId, status: 'done' }), events: [] });
      },
    };

    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay,
      createProvider: () => new FakeProvider(),
    });

    const notifications: Array<{ messages: number; runs: number; loading: number }> = [];
    source.subscribe((_event, snapshot) =>
      notifications.push({
        messages: snapshot.messages.length,
        runs: Object.keys(snapshot.sessionMetaByRun).length,
        loading: Object.keys(snapshot.runsLoading ?? {}).length,
      })
    );
    source.play();
    await flush();

    // The whole transcript is already out, every card a placeholder, before
    // a single run log has come back.
    expect(notifications).toEqual([{ messages: 8, runs: 0, loading: 8 }]);
    // Only 6 (BOOTSTRAP_RUN_CONCURRENCY) at once — bounded, and parallel —
    // and the newest first: the bottom of the transcript, where it opens.
    expect([...pending.keys()]).toEqual(['run8', 'run7', 'run6', 'run5', 'run4', 'run3']);
    expect(maxInFlight).toBe(6);

    for (const resolve of [...pending.values()]) resolve();
    await flush();

    // One announcement for those 6, not one per run; the last 2 started as slots freed up.
    expect(notifications.slice(1)).toEqual([{ messages: 8, runs: 6, loading: 2 }]);
    expect([...pending.keys()].slice(6)).toEqual(['run2', 'run1']);
    for (const resolve of [...pending.values()]) resolve();
    await flush();

    expect(notifications.slice(2)).toEqual([{ messages: 8, runs: 8, loading: 0 }]);
    expect(Object.keys(source.getSnapshot().sessionMetaByRun).sort()).toEqual(runIds);
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

  it('send() carries the reply and the asked mark in the message meta', async () => {
    const metas: unknown[] = [];
    const fake = makeFakeRelay({
      async postMessage(_bindingId, input) {
        metas.push(input.meta);
        return ok(message({ id: 'posted-2', seq: 1000, body: input.body }));
      },
    });
    fake.queueMessages([]);
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => new FakeProvider(),
    });
    const replyTo = { id: 'm9', authorId: 'u1', label: 'Your Claude', excerpt: 'Which call did you mean?' };
    await source.send('ok not this one', replyTo, 'claude');
    await source.send('just chat');
    expect(metas).toEqual([{ replyTo, asks: 'claude' }, undefined]);
  });

  it('send() puts tagged people in meta.mentions (ids) and meta.mentionNames, and reads them back', async () => {
    const metas: unknown[] = [];
    const fake = makeFakeRelay({
      async postMessage(_bindingId, input) {
        metas.push(input.meta);
        return ok(message({ id: 'posted-3', seq: 1000, body: input.body }));
      },
    });
    fake.queueMessages([
      message({
        id: 'm-tag',
        body: '@Alex Martin and @Jérémie Rappaz',
        author: { userId: 'former_usr_x', name: 'Former member', avatarUrl: null, kind: 'user' },
        meta: { mentions: ['usr_a', 'usr_j'], mentionNames: ['Alex Martin', 'Jérémie Rappaz'] },
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
    await source.send('@Alex Martin hi', undefined, undefined, { mentions: [{ id: 'usr_a', name: 'Alex Martin' }] });
    expect(metas).toEqual([{ mentions: ['usr_a'], mentionNames: ['Alex Martin'] }]);
    const received = source.getSnapshot().messages.find((m) => m.id === 'm-tag');
    expect(received?.meta).toMatchObject({
      kind: 'text',
      mentions: [
        { id: 'usr_a', name: 'Alex Martin' },
        { id: 'usr_j', name: 'Jérémie Rappaz' },
      ],
    });
    // The relay's own name for an author who's gone: never their id.
    expect(received).toMatchObject({ authorId: 'former_usr_x', authorName: 'Former member' });
  });

  it('previewDraft() asks the relay, and reads a failure or no client as "none"', async () => {
    const asked: Array<[string, string]> = [];
    const none = { answersTo: null, agent: null, confidence: 0 };
    const withPreview = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: makeFakeRelay({
        async previewDraft(bindingId, text) {
          asked.push([bindingId, text]);
          return { answersTo: 'm9', agent: 'claude', confidence: 0.8 };
        },
      }).relay,
      createProvider: () => new FakeProvider(),
    });
    expect(await withPreview.previewDraft('ok not this one')).toEqual({ answersTo: 'm9', agent: 'claude', confidence: 0.8 });
    expect(asked).toEqual([[BINDING, 'ok not this one']]);

    const failing = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: makeFakeRelay({ previewDraft: async () => Promise.reject(new Error('ipc down')) }).relay,
      createProvider: () => new FakeProvider(),
    });
    expect(await failing.previewDraft('x')).toEqual(none);

    const without = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: makeFakeRelay().relay,
      createProvider: () => new FakeProvider(),
    });
    expect(await without.previewDraft('x')).toEqual(none);
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

  it('refetches the connector list when a connectors_added system message arrives live, but not for one already in the history', async () => {
    let listCalls = 0;
    const fake = makeFakeRelay({
      listConnectors: async () => {
        listCalls += 1;
        return ok(listCalls === 1 ? [] : [{ connectorId: 'notion', addedBy: 'u1', addedAt: '' }]);
      },
    });
    const added = (id: string, seq: number) =>
      message({ id, seq, kind: 'system', body: 'Dylan added Notion', meta: { event: 'connectors_added', connectorIds: ['notion'] } });
    fake.queueMessages(
      [added('m2', 2)], // history: bootstrap's own list already reflects it
      [], // connect-time catch-up: nothing new
      [added('m3', 3)] // live
    );
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
    expect(listCalls).toBe(1);

    provider!.fire('connect');
    await flush();
    provider!.fire('stateless', { payload: JSON.stringify({ type: 'message_created', id: 'm3', seq: 3, kind: 'system' }) });
    await flush();
    // The live message's own refetch — the final snapshot reflects it.
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

  it("carries the connection's own account (who you're signed in as) into RoomConnector, on bootstrap and on refresh", async () => {
    const fake = makeFakeRelay({
      listConnectors: async () => ok([{ connectorId: 'linear', addedBy: 'u1', addedAt: '' }]),
    });
    let account: string | undefined;
    const connections = { list: vi.fn(async () => [{ id: 'linear' as const, state: 'connected' as const, account }]) };
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
    // Optional, per connectors.ts — not every connector reports it (yet).
    expect(source.getSnapshot().connectors[0]!.account).toBeUndefined();

    // Once the connector starts reporting an account, a refresh picks it up.
    account = 'dtsbourg@gmail.com';
    await source.refreshConnections();
    expect(source.getSnapshot().connectors[0]!.account).toBe('dtsbourg@gmail.com');
  });
});

describe('RelayRoomSource without the realtime socket', () => {
  /** A relay whose message log grows like the real one: `?after=` returns only what's newer. */
  function growingRelay() {
    const fake = makeFakeRelay();
    const log: RoomMessageRow[] = [message()];
    let listMessagesCalls = 0;
    let listMembersCalls = 0;
    let members: RoomMemberRow[] = [member()];
    const eventCalls: string[] = [];
    const getSessionEvents = fake.relay.getSessionEvents.bind(fake.relay);
    fake.relay.listMessages = async (_bindingId, query) => {
      listMessagesCalls += 1;
      const after = query.after ? Number(query.after) : 0;
      return ok(log.filter((m) => m.seq > after));
    };
    fake.relay.listMembers = async () => {
      listMembersCalls += 1;
      return ok(members);
    };
    fake.relay.getSessionEvents = async (bindingId, runId, after) => {
      eventCalls.push(runId);
      return getSessionEvents(bindingId, runId, after);
    };
    return {
      fake,
      post: (row: RoomMessageRow) => log.push(row),
      setMembers: (rows: RoomMemberRow[]) => (members = rows),
      calls: () => ({ listMessages: listMessagesCalls, listMembers: listMembersCalls }),
      eventCalls,
    };
  }

  function makeSource(relay: RelayRoomClient, createProvider: () => RealtimeProvider | Promise<RealtimeProvider>) {
    return new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay,
      createProvider,
      pollIntervalMs: 10,
      connectGraceMs: 30,
    });
  }

  it('never connects (the upgrade 404s, so the provider only ever reports disconnect): polls for messages, runs and members', async () => {
    const relay = growingRelay();
    let provider: FakeProvider | null = null;
    const source = makeSource(relay.fake.relay, () => (provider = new FakeProvider()));
    source.play();
    await flush();
    expect(source.getSnapshot().connection).toBe('connecting');

    // Each failed attempt reports a disconnect; the Room goes quiet-offline once.
    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type === 'connection_changed' ? `connection:${event.connection}` : event.type));
    provider!.fire('disconnect');
    provider!.fire('disconnect');
    expect(source.getSnapshot().connection).toBe('offline');
    expect(seen.filter((t) => t === 'connection:offline')).toHaveLength(1);

    // A new chat message, and a run that starts and keeps logging events.
    relay.post(message({ id: 'm2', seq: 2, body: 'still there?' }));
    relay.fake.setRun('run1', run(), [sessionEvent({ seq: 1 })]);
    relay.post(message({ id: 'm3', seq: 3, kind: 'session', body: '', meta: { runId: 'run1' } }));
    await wait(40);
    expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(source.getSnapshot().sessionEventsByRun.run1!.map((e) => e.seq)).toEqual([1]);

    relay.fake.appendEvents('run1', [sessionEvent({ seq: 2, kind: 'tool_call_update' })]);
    await wait(40);
    expect(source.getSnapshot().sessionEventsByRun.run1!.map((e) => e.seq)).toEqual([1, 2]);

    // Someone joins without a join message reaching us: the roster poll still finds them.
    relay.setMembers([member(), member({ userId: 'u-sam', name: 'Sam', role: 'editor' })]);
    await wait(120);
    expect(source.getSnapshot().members.map((m) => m.id)).toEqual(['u1', 'u-sam']);
    expect(seen).toContain('members_synced');
    source.dispose();
  });

  it('never connects and never even says so: starts polling after the grace period anyway', async () => {
    const relay = growingRelay();
    const source = makeSource(relay.fake.relay, () => new FakeProvider());
    source.play();
    await flush();
    expect(source.getSnapshot().connection).toBe('connecting');
    await wait(50);
    expect(source.getSnapshot().connection).toBe('offline');
    relay.post(message({ id: 'm2', seq: 2, body: 'hello?' }));
    await wait(40);
    expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    source.dispose();
  });

  it('cannot even build the provider: still polls', async () => {
    const relay = growingRelay();
    const source = makeSource(relay.fake.relay, async () => {
      throw new Error('no websocket for you');
    });
    source.play();
    await flush();
    expect(source.getSnapshot().connection).toBe('offline');
    relay.post(message({ id: 'm2', seq: 2 }));
    await wait(40);
    expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    source.dispose();
  });

  it('drops then recovers: polls only while the socket is down, and catches up once it is back', async () => {
    const relay = growingRelay();
    let provider: FakeProvider | null = null;
    const source = makeSource(relay.fake.relay, () => (provider = new FakeProvider()));
    source.play();
    await flush();
    provider!.fire('connect');
    await flush();
    expect(source.getSnapshot().connection).toBe('online');

    // Connected: nothing polls, however long we wait.
    const whileOnline = relay.calls().listMessages;
    await wait(60);
    expect(relay.calls().listMessages).toBe(whileOnline);

    // Dropped: polling picks up what the socket would have told us.
    provider!.fire('disconnect');
    expect(source.getSnapshot().connection).toBe('offline');
    relay.post(message({ id: 'm2', seq: 2, body: 'missed this' }));
    await wait(40);
    expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(relay.calls().listMessages).toBeGreaterThan(whileOnline + 1);

    // Back: one catch-up, then polling stops.
    relay.post(message({ id: 'm3', seq: 3 }));
    provider!.fire('connect');
    await flush();
    expect(source.getSnapshot().connection).toBe('online');
    expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    const afterRecovery = relay.calls().listMessages;
    await wait(60);
    expect(relay.calls().listMessages).toBe(afterRecovery);
    source.dispose();
  });

  it("polling skips runs that have already finished (a long history doesn't mean a request per run per poll)", async () => {
    const relay = growingRelay();
    relay.fake.setRun('done1', run({ id: 'done1', status: 'done' }), [sessionEvent({ runId: 'done1', seq: 1 })]);
    relay.fake.setRun('live1', run({ id: 'live1' }), [sessionEvent({ runId: 'live1', seq: 1 })]);
    relay.post(message({ id: 'm2', seq: 2, kind: 'session', body: '', meta: { runId: 'done1' } }));
    relay.post(message({ id: 'm3', seq: 3, kind: 'session', body: '', meta: { runId: 'live1' } }));
    let provider: FakeProvider | null = null;
    const source = makeSource(relay.fake.relay, () => (provider = new FakeProvider()));
    source.play();
    await flush();
    relay.eventCalls.length = 0;
    provider!.fire('disconnect');
    await wait(50);
    expect(relay.eventCalls.length).toBeGreaterThan(0);
    expect(new Set(relay.eventCalls)).toEqual(new Set(['live1']));
    source.dispose();
  });

  it('clears anyone "typing" when the socket drops (no awareness updates would ever clear it)', async () => {
    const relay = growingRelay();
    let provider: FakeProvider | null = null;
    const source = makeSource(relay.fake.relay, () => (provider = new FakeProvider()));
    source.play();
    await flush();
    provider!.fire('connect');
    provider!.setAwareness([{ user: { id: 'u1' } }, { user: { id: 'u-sam' }, typing: true }]);
    expect(source.getSnapshot().typingUserIds).toEqual(['u-sam']);
    provider!.fire('disconnect');
    expect(source.getSnapshot().typingUserIds).toEqual([]);
    source.dispose();
  });

  it('pause() and dispose() stop the polling', async () => {
    const relay = growingRelay();
    let provider: FakeProvider | null = null;
    const source = makeSource(relay.fake.relay, () => (provider = new FakeProvider()));
    source.play();
    await flush();
    provider!.fire('disconnect');
    await wait(30);
    source.pause();
    provider!.fire('disconnect'); // the real provider reports its own close
    const paused = relay.calls().listMessages;
    await wait(50);
    expect(relay.calls().listMessages).toBe(paused);
    source.dispose();
  });
});

describe('RelayRoomSource — a finished run’s end time', () => {
  // A run's status change isn't broadcast: the Room only hears its events.
  // The header it read when the run started says running, no end time, and
  // the card used to measure "Worked …" against the clock from then on.
  function open(fake: ReturnType<typeof makeFakeRelay>) {
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => (provider = new FakeProvider()),
      runEndRefreshMs: 0,
    });
    return { source, provider: () => provider! };
  }

  function recordingAfter(fake: ReturnType<typeof makeFakeRelay>): number[] {
    const afters: number[] = [];
    const original = fake.relay.getSessionEvents;
    fake.relay.getSessionEvents = (bindingId, runId, after) => {
      afters.push(after ?? 0);
      return original(bindingId, runId, after);
    };
    return afters;
  }

  it('re-reads the header once the log says it ended, so the card shows ended − started', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([message({ kind: 'session', body: '', meta: { runId: 'run1' } })], []);
    fake.setRun('run1', run(), [sessionEvent({ seq: 1 })]);
    const afters = recordingAfter(fake);
    const { source, provider } = open(fake);
    source.play();
    await flush();
    provider().fire('connect');
    await flush();
    expect(source.getSnapshot().sessionMetaByRun.run1).toMatchObject({ status: 'running', endedAt: null });

    // It finishes: its last event lands, and the relay stamps its end.
    fake.setRun('run1', run({ status: 'done', endedAt: '2026-09-23T09:00:13.500Z' }), [
      sessionEvent({ seq: 1 }),
      sessionEvent({ seq: 2, kind: 'turn_ended', payload: { status: 'done' } }),
    ]);
    afters.length = 0;
    provider().fire('stateless', { payload: JSON.stringify({ type: 'session_event_appended', runId: 'run1', seq: 2 }) });
    await flush();

    expect(source.getSnapshot().sessionMetaByRun.run1).toMatchObject({ status: 'done', endedAt: '2026-09-23T09:00:13.500Z' });
    // The events since seq 1, then the header alone (no events again).
    expect(afters).toHaveLength(2);
    expect(afters[0]).toBe(1);
    expect(afters[1]).toBeGreaterThan(1_000_000);
    source.dispose();
  });

  it('a relay that has not stamped the end yet is asked again, a few times at most', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([message({ kind: 'session', body: '', meta: { runId: 'run1' } })], []);
    fake.setRun('run1', run(), [sessionEvent({ seq: 1 }), sessionEvent({ seq: 2, kind: 'turn_ended', payload: { status: 'done' } })]);
    const afters = recordingAfter(fake);
    const { source } = open(fake);
    source.play();
    await flush(20);
    expect(afters.filter((a) => a > 1_000_000)).toHaveLength(3);
    expect(source.getSnapshot().sessionMetaByRun.run1!.endedAt).toBeNull();
    source.dispose();
  });

  it('a run whose header already says it finished is not re-read', async () => {
    const fake = makeFakeRelay();
    fake.queueMessages([message({ kind: 'session', body: '', meta: { runId: 'run1' } })], []);
    fake.setRun('run1', run({ status: 'done', endedAt: '2026-09-23T09:00:10Z' }), [
      sessionEvent({ seq: 1, kind: 'turn_ended', payload: { status: 'done' } }),
    ]);
    const afters = recordingAfter(fake);
    const { source } = open(fake);
    source.play();
    await flush(20);
    expect(afters).toEqual([0]);
    source.dispose();
  });
});

describe('RelayRoomSource — how many requests an open and its catch-ups make', () => {
  /** A fake relay that records every call by name (and every run it fetches). */
  function countingFake() {
    const fake = makeFakeRelay();
    const calls: string[] = [];
    const eventCalls: string[] = [];
    const relay = fake.relay;
    for (const name of Object.keys(relay) as Array<keyof RelayRoomClient>) {
      const original = relay[name] as (...args: unknown[]) => unknown;
      (relay as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        calls.push(name);
        if (name === 'getSessionEvents') eventCalls.push(args[1] as string);
        return original(...args);
      };
    }
    return { fake, calls, eventCalls, reset: () => ((calls.length = 0), (eventCalls.length = 0)) };
  }

  function sessionMessages(runIds: string[], firstSeq = 1): RoomMessageRow[] {
    return runIds.map((id, i) => message({ id: `m-${id}`, seq: firstSeq + i, kind: 'session', body: '', meta: { runId: id } }));
  }

  function open(relay: RelayRoomClient) {
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay,
      createProvider: () => (provider = new FakeProvider()),
    });
    return { source, provider: () => provider! };
  }

  it('connecting with 30 finished runs in the history fetches none of them again', async () => {
    const { fake, calls, eventCalls, reset } = countingFake();
    const runIds = Array.from({ length: 30 }, (_, i) => `done${i}`);
    for (const id of runIds) fake.setRun(id, run({ id, status: 'done' }), [sessionEvent({ runId: id, seq: 1 })]);
    fake.queueMessages(sessionMessages(runIds), []);
    const { source, provider } = open(fake.relay);
    source.play();
    await flush();
    expect(new Set(eventCalls)).toEqual(new Set(runIds)); // bootstrap: each run once
    expect(eventCalls).toHaveLength(30);

    reset();
    provider().fire('connect');
    await flush();
    expect(calls.filter((c) => c !== 'mintRealtimeTicket')).toEqual(['listMessages']);
    source.dispose();
  });

  it('a session_event_appended notification for run X fetches only X', async () => {
    const { fake, eventCalls, calls, reset } = countingFake();
    for (const id of ['x', 'y', 'z']) fake.setRun(id, run({ id }), [sessionEvent({ runId: id, seq: 1 })]);
    fake.queueMessages(sessionMessages(['x', 'y', 'z']), []);
    const { source, provider } = open(fake.relay);
    source.play();
    await flush();
    provider().fire('connect');
    await flush();

    reset();
    fake.appendEvents('x', [sessionEvent({ runId: 'x', seq: 2, kind: 'tool_call_update' })]);
    provider().fire('stateless', { payload: JSON.stringify({ type: 'session_event_appended', runId: 'x', seq: 2 }) });
    await flush();
    expect(eventCalls).toEqual(['x']);
    expect(calls).toEqual(['getSessionEvents']); // no message listing either
    expect(source.getSnapshot().sessionEventsByRun.x!.map((e) => e.seq)).toEqual([1, 2]);
    source.dispose();
  });

  it('a new message fetches the messages since the last one, and only a run it newly names', async () => {
    const { fake, eventCalls, calls, reset } = countingFake();
    fake.setRun('old', run({ id: 'old' }), [sessionEvent({ runId: 'old', seq: 1 })]);
    fake.setRun('new', run({ id: 'new' }), [sessionEvent({ runId: 'new', seq: 1 })]);
    fake.queueMessages(sessionMessages(['old']), [], sessionMessages(['new'], 2));
    const { source, provider } = open(fake.relay);
    source.play();
    await flush();
    provider().fire('connect');
    await flush();

    reset();
    provider().fire('stateless', { payload: JSON.stringify({ type: 'message_created', id: 'm-new', seq: 2, kind: 'session' }) });
    await flush();
    expect(calls).toEqual(['listMessages', 'getSessionEvents']);
    expect(eventCalls).toEqual(['new']);
    source.dispose();
  });

  it('a reconnect re-reads the runs that were going when the socket dropped, and no finished one', async () => {
    const { fake, eventCalls, reset } = countingFake();
    fake.setRun('live', run({ id: 'live' }), [sessionEvent({ runId: 'live', seq: 1 })]);
    fake.setRun('done', run({ id: 'done', status: 'done' }), [sessionEvent({ runId: 'done', seq: 1 })]);
    fake.queueMessages(sessionMessages(['live', 'done']), [], []);
    const { source, provider } = open(fake.relay);
    source.play();
    await flush();
    provider().fire('connect');
    await flush();
    provider().fire('disconnect');

    // It finished while the socket was down.
    fake.appendEvents('live', [sessionEvent({ runId: 'live', seq: 2, kind: 'turn_ended', payload: { status: 'done' } })]);
    reset();
    provider().fire('connect');
    await flush();
    expect(eventCalls).toEqual(['live']);
    expect(source.getSnapshot().sessionEventsByRun.live!.map((e) => e.seq)).toEqual([1, 2]);
    source.dispose();
  });

  it('dispose() while run logs are loading stops further fetches, and nothing more is applied or announced', async () => {
    const { fake, eventCalls } = countingFake();
    const runIds = Array.from({ length: 10 }, (_, i) => `run${i}`);
    fake.queueMessages(sessionMessages(runIds));
    const pending: Array<() => void> = [];
    const relay: RelayRoomClient = {
      ...fake.relay,
      async getSessionEvents(bindingId, runId, after) {
        eventCalls.push(runId);
        await new Promise<void>((resolve) => pending.push(resolve));
        return ok({ run: run({ id: runId }), events: [] });
      },
    };
    const { source, provider } = open(relay);
    const notified: string[] = [];
    source.subscribe((event) => notified.push(event.type));
    source.play();
    await flush();
    expect(eventCalls).toHaveLength(6); // the first bounded batch
    expect(notified).toEqual(['message_created']); // the transcript, already out

    source.dispose();
    for (const resolve of pending.splice(0)) resolve();
    await flush();
    expect(eventCalls).toHaveLength(6); // the other 4 never started
    expect(notified).toEqual(['message_created']);
    expect(source.getSnapshot().sessionMetaByRun).toEqual({});
    expect(provider().destroyCalls).toBe(1);
  });

  it('dispose() before the messages are in: nothing is applied or announced, and no socket opens', async () => {
    const fake = makeFakeRelay();
    let answer: (() => void) | null = null;
    const relay: RelayRoomClient = {
      ...fake.relay,
      listMessages: async () => {
        await new Promise<void>((resolve) => (answer = resolve));
        return ok([message()]);
      },
    };
    const { source, provider } = open(relay);
    const notified: string[] = [];
    source.subscribe((event) => notified.push(event.type));
    source.play();
    await flush();
    source.dispose();
    answer!();
    await flush();
    expect(notified).toEqual([]);
    expect(source.getSnapshot().messages).toEqual([]);
    expect(provider()).toBeNull();
  });

  it('asks for roster, messages, skills, invites and connectors all at once, and shows them before any run log is back', async () => {
    const started: string[] = [];
    const gate: Array<() => void> = [];
    const held = <T,>(name: string, value: T) => async (): Promise<T> => {
      started.push(name);
      await new Promise<void>((resolve) => gate.push(resolve));
      return value;
    };
    const fake = makeFakeRelay();
    let answerRun: (() => void) | null = null;
    const relay: RelayRoomClient = {
      ...fake.relay,
      listMembers: held('listMembers', ok([member()])),
      listSkills: held('listSkills', []),
      listInvites: held('listInvites', ok([])),
      listConnectors: held('listConnectors', ok([])),
      listMessages: async () => {
        started.push('listMessages');
        return ok(sessionMessages(['run1']));
      },
      getSessionEvents: async (_bindingId, runId) => {
        started.push('getSessionEvents');
        await new Promise<void>((resolve) => (answerRun = resolve));
        return ok({ run: run({ id: runId }), events: [sessionEvent({ runId, seq: 1 })] });
      },
    };
    const { source } = open(relay);
    const seen: Array<{ type: string; runs: number }> = [];
    source.subscribe((event, snapshot) => seen.push({ type: event.type, runs: Object.keys(snapshot.sessionMetaByRun).length }));
    source.play();
    await flush();
    // All five out together; nothing waits for anything else.
    expect(new Set(started)).toEqual(new Set(['listMembers', 'listMessages', 'listSkills', 'listInvites', 'listConnectors']));
    for (const resolve of gate.splice(0)) resolve();
    await flush();
    // Shown (with the run as a placeholder) while its log is still out.
    expect(started).toContain('getSessionEvents');
    expect(seen).toEqual([{ type: 'message_created', runs: 0 }]);
    expect(source.getSnapshot().runsLoading).toEqual({ run1: true });

    answerRun!();
    await flush();
    expect(seen).toEqual([
      { type: 'message_created', runs: 0 },
      { type: 'session_log_loaded', runs: 1 },
    ]);
    source.dispose();
  });

  it('a run waiting on an approval at the bottom is shown promptly, without waiting for the rest of the history', async () => {
    const fake = makeFakeRelay();
    const runIds = Array.from({ length: 10 }, (_, i) => `run${i}`); // run9 is the newest
    fake.queueMessages(sessionMessages(runIds));
    const answers = new Map<string, () => void>();
    const relay: RelayRoomClient = {
      ...fake.relay,
      async getSessionEvents(_bindingId, runId) {
        await new Promise<void>((resolve) => answers.set(runId, resolve));
        const asking = runId === 'run9';
        return ok({
          run: run({ id: runId, status: asking ? 'running' : 'done' }),
          events: asking
            ? [sessionEvent({ runId, seq: 1, kind: 'permission_requested', payload: { requestId: 'p1', toolCall: { toolCallId: 't1', title: 'rm -rf build' }, options: [] } })]
            : [],
        });
      },
    };
    const { source } = open(relay);
    const announced: number[] = [];
    source.subscribe((_event, snapshot) => announced.push(Object.keys(snapshot.sessionMetaByRun).length));
    source.play();
    await flush();
    expect([...answers.keys()][0]).toBe('run9'); // asked first

    answers.get('run9')!();
    await wait(60); // one short batch window, not the whole history
    expect(announced.at(-1)).toBe(1);
    expect(source.getSnapshot().sessionEventsByRun.run9?.[0]?.kind).toBe('permission_requested');
    for (const resolve of answers.values()) resolve();
    source.dispose();
  });

  it('a run named by a notification while its log is still loading is re-read once that log is in', async () => {
    const { fake, eventCalls } = countingFake();
    let answer: (() => void) | null = null;
    const relay: RelayRoomClient = {
      ...fake.relay,
      async getSessionEvents(bindingId, runId, after = 0) {
        eventCalls.push(`${runId}@${after}`);
        if (after === 0) await new Promise<void>((resolve) => (answer = resolve));
        // The first fetch went out before seq 2 existed.
        const events = after === 0 ? [sessionEvent({ runId, seq: 1 })] : [sessionEvent({ runId, seq: 2, kind: 'tool_call_update' })];
        return ok({ run: run({ id: runId }), events });
      },
    };
    fake.queueMessages(sessionMessages(['run1']), []);
    const { source, provider } = open(relay);
    source.play();
    await flush();
    provider().fire('connect');
    provider().fire('stateless', { payload: JSON.stringify({ type: 'session_event_appended', runId: 'run1', seq: 2 }) });
    await flush();
    expect(eventCalls).toEqual(['run1@0']); // nothing fetched for it until its log is in

    answer!();
    await flush();
    expect(eventCalls).toEqual(['run1@0', 'run1@1']);
    expect(source.getSnapshot().sessionEventsByRun.run1!.map((e) => e.seq)).toEqual([1, 2]);
    source.dispose();
  });

  it('a new message naming a run still loading from the open does not fetch it a second time', async () => {
    const { fake, eventCalls } = countingFake();
    let answer: (() => void) | null = null;
    const relay: RelayRoomClient = {
      ...fake.relay,
      async getSessionEvents(_bindingId, runId) {
        eventCalls.push(runId);
        await new Promise<void>((resolve) => (answer = resolve));
        return ok({ run: run({ id: runId, status: 'done' }), events: [] });
      },
    };
    const again = message({ id: 'm-again', seq: 2, kind: 'session', body: '', meta: { runId: 'run1' } });
    fake.queueMessages(sessionMessages(['run1']), [again]);
    const { source, provider } = open(relay);
    source.play();
    await flush();
    provider().fire('connect');
    await flush();
    expect(eventCalls).toEqual(['run1']);
    answer!();
    await flush();
    expect(eventCalls).toEqual(['run1']);
    expect(source.getSnapshot().messages.map((m) => m.id)).toEqual(['m-run1', 'm-again']);
    source.dispose();
  });

  it('bootstrap re-reads nothing per history message: a join, an invite and a connectors change cost no extra requests', async () => {
    const { fake, calls } = countingFake();
    const relay: RelayRoomClient = {
      ...fake.relay,
      listInvites: async () => {
        calls.push('listInvites');
        return ok([]);
      },
      listConnectors: async () => {
        calls.push('listConnectors');
        return ok([]);
      },
    };
    fake.queueMessages([
      message({ id: 'm1', seq: 1, kind: 'system', meta: { event: 'member_joined', userId: 'u-gone' } }),
      message({ id: 'm2', seq: 2, kind: 'invite', meta: { inviteId: 'inv-unknown' } }),
      message({ id: 'm3', seq: 3, kind: 'system', meta: { event: 'connectors_added', connectorIds: ['notion'] } }),
    ]);
    const { source } = open(relay);
    source.play();
    await flush();
    expect(calls.filter((c) => c === 'listMembers')).toHaveLength(1);
    expect(calls.filter((c) => c === 'listInvites')).toHaveLength(1);
    expect(calls.filter((c) => c === 'listConnectors')).toHaveLength(1);
    expect(source.getSnapshot().messages).toHaveLength(3);
    source.dispose();
  });

  it('an empty space reads as loaded (and says so) once its messages are in, before any socket', async () => {
    const fake = makeFakeRelay();
    const { source } = open(fake.relay);
    expect(source.getSnapshot().loaded).toBe(false);
    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    source.play();
    await flush();
    expect(source.getSnapshot().loaded).toBe(true);
    expect(source.getSnapshot().connection).toBe('connecting');
    expect(seen).toEqual(['room_loaded']);
    source.dispose();
  });

  it('a fetched log lands as one reducer step: header and every event at once, placeholder cleared', () => {
    const events = [1, 2, 3].map((seq) => ({ seq, kind: 'tool_call', payload: {} }));
    const meta = { id: 'run1', agent: 'claude' as const, owner: 'u1', model: 'm', title: '', status: 'done' as const, startedAt: '', endedAt: null };
    const before = { ...buildRoomFeed().initialSnapshot, runsLoading: { run1: true as const, run2: true as const } };
    const after = reduceRoom(before, { type: 'session_log_loaded', runId: 'run1', meta, events });
    expect(after.sessionMetaByRun.run1).toBe(meta);
    expect(after.sessionEventsByRun.run1).toBe(events); // the array as fetched: no per-event copies
    expect(after.runsLoading).toEqual({ run2: true });
  });

  it('a run a live message names arrives as one event, not one per log entry', async () => {
    const { fake } = countingFake();
    fake.setRun('run2', run({ id: 'run2' }), [1, 2, 3].map((seq) => sessionEvent({ runId: 'run2', seq })));
    fake.queueMessages([message()], [], sessionMessages(['run2'], 2));
    const { source, provider } = open(fake.relay);
    source.play();
    await flush();
    provider().fire('connect');
    await flush();
    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    provider().fire('stateless', { payload: JSON.stringify({ type: 'message_created', id: 'm-run2', seq: 2, kind: 'session' }) });
    await flush();
    expect(seen).toEqual(['session_log_loaded', 'message_created']);
    expect(source.getSnapshot().sessionEventsByRun.run2!.map((e) => e.seq)).toEqual([1, 2, 3]);
    source.dispose();
  });

  it('logs the open and each catch-up at info, with timings and counts only', async () => {
    const fake = makeFakeRelay();
    fake.setRun('run1', run(), [sessionEvent({ seq: 1, bytes: 120 })]);
    fake.queueMessages(sessionMessages(['run1']), []);
    const lines: Array<{ message: string; extra?: Record<string, unknown>; level?: string }> = [];
    let provider: FakeProvider | null = null;
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      createProvider: () => (provider = new FakeProvider()),
      log: (message, extra, level) => lines.push({ message, extra, level }),
    });
    source.play();
    await flush();
    provider!.fire('connect');
    await flush();
    const info = lines.filter((l) => l.level === 'info');
    const line = (message: string) => info.find((l) => l.message === `Rig spaces: room ${message}`);
    expect(info[0]!.message).toBe('Rig spaces: room first paint');
    expect(line('first paint')!.extra).toMatchObject({ bindingId: BINDING, messages: 1, runsLoading: 1 });
    expect(line('runs loaded')!.extra).toMatchObject({ bindingId: BINDING, runs: 1, calls: 1, eventBytes: 120 });
    expect(line('socket connected')!.extra).toMatchObject({ bindingId: BINDING, reconnect: false });
    expect(line('catch-up')!.extra).toMatchObject({ messages: true, runs: 1, calls: 2 });
    expect(JSON.stringify(lines)).not.toContain('hello room');
    source.dispose();
  });
});

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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

describe('RelayRoomSource scrollback (loadOlder)', () => {
  /** A space with `count` messages; `?latest=` and `?before=` behave like the relay. */
  function longSpace(count: number) {
    const fake = makeFakeRelay();
    fake.setMembers([member()]);
    const log: RoomMessageRow[] = Array.from({ length: count }, (_, i) =>
      message({ id: `m${i + 1}`, seq: i + 1, body: `message ${i + 1}` })
    );
    const queries: Array<{ latest?: number; after?: string; before?: string }> = [];
    let fail = false;
    fake.relay.listMessages = async (_bindingId, query) => {
      queries.push(query);
      if (fail && query.before) return err<RelayApiError>({ kind: 'relay', message: 'down' });
      let rows = log;
      if (query.after) rows = rows.filter((m) => m.seq > Number(query.after));
      if (query.before) rows = rows.filter((m) => m.seq < Number(query.before));
      if (query.latest) rows = rows.slice(-query.latest);
      return ok(rows);
    };
    const source = new RelayRoomSource({
      bindingId: BINDING,
      spaceName: 'Growth',
      wsUrl: 'wss://relay.test/v1/realtime',
      selfUserId: 'u1',
      relay: fake.relay,
      bootstrapMessageCount: 50,
      createProvider: () => new FakeProvider(),
    });
    return { source, queries, setFail: (value: boolean) => (fail = value) };
  }

  it('pages back 50 at a time, in seq order, until the start of the space', async () => {
    const { source, queries } = longSpace(120);
    source.play();
    await flush();
    const seqs = () => source.getSnapshot().messages.map((m) => m.seq);
    expect(seqs()).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i));
    expect(source.getSnapshot().olderMessages).toBe('more');

    await source.loadOlder();
    expect(queries.at(-1)).toEqual({ before: '71', latest: 50 });
    expect(seqs()).toEqual(Array.from({ length: 100 }, (_, i) => 21 + i));
    expect(source.getSnapshot().olderMessages).toBe('more');

    await source.loadOlder();
    expect(seqs()).toEqual(Array.from({ length: 120 }, (_, i) => 1 + i));
    expect(source.getSnapshot().olderMessages).toBe('none');

    const calls = queries.length;
    await source.loadOlder();
    expect(queries.length).toBe(calls); // nothing above the first message
    source.dispose();
  });

  it('a short space has nothing above its first page', async () => {
    const { source } = longSpace(12);
    source.play();
    await flush();
    expect(source.getSnapshot().olderMessages).toBe('none');
    source.dispose();
  });

  it('a failed page leaves it ready to try again, and one page at a time', async () => {
    const { source, queries, setFail } = longSpace(80);
    source.play();
    await flush();
    setFail(true);
    await source.loadOlder();
    expect(source.getSnapshot().olderMessages).toBe('more');
    expect(source.getSnapshot().messages).toHaveLength(50);
    setFail(false);
    const before = queries.length;
    await Promise.all([source.loadOlder(), source.loadOlder()]);
    expect(queries.length).toBe(before + 1);
    expect(source.getSnapshot().messages).toHaveLength(80);
    source.dispose();
  });

  it('an older page is not announced as new messages', async () => {
    const { source } = longSpace(60);
    source.play();
    await flush();
    const seen: string[] = [];
    source.subscribe((event) => seen.push(event.type));
    await source.loadOlder();
    expect(seen).toEqual(['older_messages_loading', 'older_messages_loaded']);
    source.dispose();
  });
});
