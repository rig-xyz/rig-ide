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

    // `session_started`/`session_event_appended` are folded into the
    // snapshot silently during bootstrap (see "Calm Room open" below) —
    // only the final event of the batch (this message itself) notifies.
    expect(seen).toEqual(['message_created']);
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

  it('bootstrap fetches every referenced run in parallel, bounded, and notifies once for the whole batch (Calm Room open)', async () => {
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
        return ok({ run: run({ id: runId }), events: [] });
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

    const notifications: number[] = [];
    source.subscribe(() => notifications.push(Object.keys(source.getSnapshot().sessionMetaByRun).length));
    source.play();
    await flush();

    // Only the first 6 (BOOTSTRAP_RUN_CONCURRENCY) are kicked off together —
    // not all 8 at once (bounded), and not one at a time (parallel).
    expect(pending.size).toBe(6);
    expect(maxInFlight).toBe(6);
    expect(notifications).toEqual([]); // nothing announced mid-bootstrap

    for (const resolve of [...pending.values()]) resolve();
    await flush();

    // The 2 remaining runs started as soon as a slot freed up.
    expect(pending.size).toBe(8);
    for (const resolve of [...pending.values()]) resolve();
    await flush();

    // Exactly one notification for the entire bootstrap, once every run has
    // loaded — never a trickle of one update per run or per message.
    expect(notifications).toEqual([8]);
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
