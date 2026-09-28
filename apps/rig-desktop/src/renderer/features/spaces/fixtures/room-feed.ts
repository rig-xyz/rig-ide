/**
 * Spaces (lane 2): the scripted room feed — Bob (CEO), Alice (CTO) and
 * Carol (CMO) share `#launch-numbers`. Follows the product reference demo's
 * story beat-for-beat (invite → question → Alice wires up a skill → Bob
 * runs it → Alice corrects it → next morning's rerun → a comment reaches an
 * agent → Carol joins and traces what changed), condensed and adapted so
 * every session card in the room is backed by one of the 6 REAL exported
 * runs in `./index.ts` rather than fabricated step-by-step tool calls.
 *
 * Because there are exactly 6 real runs and 6 narrative "someone's agent
 * does something" moments, each real run is used exactly once; the agent
 * doing the work (Claude vs Codex) follows whichever the real run actually
 * is, which occasionally differs from the reference demo's own assignment
 * (e.g. Carol's Google Ads pull is her Codex here, not her Claude, because
 * the sixth real run happens to be a Codex one). The chat narrative and the
 * session card's real projected content (steps/outputs/final answer) are
 * therefore two honest, independently-real things sitting next to each
 * other — not a single fabricated transcript.
 *
 * `buildRoomFeed()` returns a `RoomFeedScript` (see `../room-source.ts`):
 * an `initialSnapshot`, an ordered list of timed `beats`, and the pure
 * `reduce` function `FixtureRoomSource` folds them with.
 */

import type { RoomFeedBeat, RoomFeedScript } from '../room-source';
import type {
  AgentKind,
  MessageMeta,
  PersonId,
  RoomConnector,
  RoomEvent,
  RoomMember,
  RoomMessage,
  RoomSkill,
  RoomSnapshot,
  SessionEvent,
  SessionRunMeta,
} from '../types';
import { fixtureRun, FIXTURE_EVENTS, type FixtureRunKey } from './index';

const PEOPLE: Record<PersonId, RoomMember> = {
  bob: { id: 'bob', name: 'Bob', email: 'bob@acme.com', role: 'CEO', initial: 'B', status: 'here' },
  alice: {
    id: 'alice',
    name: 'Alice',
    email: 'alice@acme.com',
    role: 'CTO',
    initial: 'A',
    status: 'invited',
  },
  carol: {
    id: 'carol',
    name: 'Carol',
    email: 'carol@acme.com',
    role: 'CMO',
    initial: 'C',
    status: 'invited',
  },
};

const CONNECTORS: Record<string, RoomConnector> = {
  metabase: { id: 'metabase', name: 'Metabase', logo: 'metabase', addedBy: 'alice' },
  mixpanel: { id: 'mixpanel', name: 'Mixpanel', logo: 'mixpanel', addedBy: 'alice' },
};

const SKILL_LAUNCH_REVIEW: RoomSkill = {
  cmd: '/launch-review',
  name: 'launch-review',
  desc: 'Launch numbers from Metabase and Mixpanel',
  addedBy: 'alice',
};

// ────────── pure reducer ──────────

export function reduceRoom(snapshot: RoomSnapshot, event: RoomEvent): RoomSnapshot {
  switch (event.type) {
    case 'message_created':
      return { ...snapshot, messages: [...snapshot.messages, event.message] };

    case 'session_event_appended': {
      const existing = snapshot.sessionEventsByRun[event.runId] ?? [];
      return {
        ...snapshot,
        sessionEventsByRun: {
          ...snapshot.sessionEventsByRun,
          [event.runId]: [...existing, event.event],
        },
      };
    }

    case 'session_started': {
      const hasAgent = snapshot.agents.some(
        (a) => a.agent === event.meta.agent && a.owner === event.meta.owner
      );
      const agents = hasAgent
        ? snapshot.agents
        : [
            ...snapshot.agents,
            { agent: event.meta.agent, owner: event.meta.owner, model: event.meta.model, busy: false },
          ];
      return {
        ...snapshot,
        agents,
        sessionMetaByRun: { ...snapshot.sessionMetaByRun, [event.runId]: event.meta },
        sessionEventsByRun: { ...snapshot.sessionEventsByRun, [event.runId]: [] },
      };
    }

    case 'session_log_loaded': {
      // One copy of the whole log, not one array copy per event.
      const started = reduceRoom(snapshot, { type: 'session_started', runId: event.runId, meta: event.meta });
      const next = { ...started, sessionEventsByRun: { ...started.sessionEventsByRun, [event.runId]: event.events } };
      if (!snapshot.runsLoading?.[event.runId]) return next;
      const { [event.runId]: _loaded, ...runsLoading } = snapshot.runsLoading;
      return { ...next, runsLoading };
    }

    case 'agent_request_created':
      // Transient signal only (a request was made) — no components in
      // lane 2 render off it yet; kept in the event stream for lane 3's
      // relay contract (a real "your agent was asked to do X" toast/queue
      // would subscribe to this).
      return snapshot;

    case 'member_invited': {
      const person = PEOPLE[event.who];
      const alreadyMember = snapshot.members.some((m) => m.id === event.who);
      return {
        ...snapshot,
        members: alreadyMember ? snapshot.members : [...snapshot.members, { ...person, status: 'invited' }],
        invitesById: {
          ...snapshot.invitesById,
          [event.inviteId]: { id: event.inviteId, by: event.by, who: event.who, status: 'sent' },
        },
      };
    }

    case 'member_joined':
      return {
        ...snapshot,
        members: snapshot.members.map((m) => (m.id === event.id ? { ...m, status: 'here' } : m)),
      };

    case 'members_synced':
      return { ...snapshot, members: event.members };

    case 'invite_status_changed':
      return {
        ...snapshot,
        invitesById: {
          ...snapshot.invitesById,
          [event.inviteId]: { ...snapshot.invitesById[event.inviteId], status: event.status },
        },
      };

    case 'connector_added':
      return { ...snapshot, connectors: [...snapshot.connectors, event.connector] };

    case 'connectors_synced':
      return { ...snapshot, connectors: event.connectors };

    case 'skill_added':
      return { ...snapshot, skills: [...snapshot.skills, event.skill] };

    case 'agent_busy_changed': {
      const idx = snapshot.agents.findIndex(
        (a) => a.agent === event.agent && a.owner === event.owner
      );
      if (idx === -1) return snapshot;
      const agents = [...snapshot.agents];
      agents[idx] = { ...agents[idx], busy: event.busy };
      return { ...snapshot, agents };
    }

    case 'connection_changed':
      return { ...snapshot, connection: event.connection };

    case 'presence_changed':
      return {
        ...snapshot,
        members: snapshot.members.map((m) => ({ ...m, online: event.onlineIds.includes(m.id) })),
      };

    case 'typing_started':
      return {
        ...snapshot,
        typingUserIds: snapshot.typingUserIds.includes(event.personId)
          ? snapshot.typingUserIds
          : [...snapshot.typingUserIds, event.personId],
      };

    case 'typing_stopped':
      return {
        ...snapshot,
        typingUserIds: snapshot.typingUserIds.filter((id) => id !== event.personId),
      };

    case 'space_ready_changed':
      return { ...snapshot, ready: event.ready };

    case 'room_loaded':
      return { ...snapshot, loaded: true };

    case 'room_renamed':
      return { ...snapshot, name: event.name };

    default:
      return snapshot;
  }
}

// ────────── beat builder ──────────

let seqCounter = 0;
let msgCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function textMessage(authorId: PersonId, body: string, time: string): RoomMessage {
  msgCounter += 1;
  return {
    id: `m${msgCounter}`,
    seq: nextSeq(),
    authorId,
    createdAt: `2026-09-22T${time}:00-04:00`,
    time,
    body,
    meta: { kind: 'text' },
  };
}

function systemMessage(
  authorId: PersonId,
  event: string,
  time: string,
  body?: string,
  connectorIds?: string[]
): RoomMessage {
  msgCounter += 1;
  return {
    id: `m${msgCounter}`,
    seq: nextSeq(),
    authorId,
    createdAt: `2026-09-22T${time}:00-04:00`,
    time,
    body,
    meta: { kind: 'system', event, ...(connectorIds ? { connectorIds } : {}) },
  };
}

function inviteMessage(by: PersonId, inviteId: string, time: string): RoomMessage {
  msgCounter += 1;
  return {
    id: `m${msgCounter}`,
    seq: nextSeq(),
    authorId: by,
    createdAt: `2026-09-22T${time}:00-04:00`,
    time,
    meta: { kind: 'invite', inviteId },
  };
}

function sessionMessage(authorId: PersonId, runId: string, time: string): RoomMessage {
  msgCounter += 1;
  return {
    id: `m${msgCounter}`,
    seq: nextSeq(),
    authorId,
    createdAt: `2026-09-22T${time}:00-04:00`,
    time,
    meta: { kind: 'session', runId },
  };
}

function commentMirrorMessage(
  by: PersonId,
  commentId: string,
  path: string,
  quote: string,
  text: string,
  time: string,
  replyFromAgent?: AgentKind
): RoomMessage {
  msgCounter += 1;
  const meta: MessageMeta = { kind: 'comment_mirror', commentId, path, quote, replyFromAgent };
  return {
    id: `m${msgCounter}`,
    seq: nextSeq(),
    authorId: by,
    createdAt: `2026-09-22T${time}:00-04:00`,
    time,
    body: text,
    meta,
  };
}

/** Turns one real fixture run's full event log into per-event beats, so the session card genuinely grows step by step the way it would live. */
function sessionEventBeats(runId: string, events: readonly SessionEvent[], perEventMs: number): RoomFeedBeat[] {
  return events.map((event) => ({
    delayMs: perEventMs,
    events: [{ type: 'session_event_appended', runId, seq: event.seq, event }],
  }));
}

function runMeta(key: FixtureRunKey, owner: PersonId, friendlyModel: string): SessionRunMeta {
  const run = fixtureRun(key);
  return {
    id: run.id,
    agent: run.agent,
    owner,
    model: run.model ?? friendlyModel,
    title: run.title,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

/** One narrative "someone's agent does real work" moment: a request, the session starting, its real events replaying, and the agent going idle again. */
function sessionMoment(opts: {
  requester: PersonId;
  owner: PersonId;
  agent: AgentKind;
  runKey: FixtureRunKey;
  friendlyModel: string;
  authorId: PersonId;
  time: string;
  perEventMs: number;
}): RoomFeedBeat[] {
  const run = fixtureRun(opts.runKey);
  const meta = runMeta(opts.runKey, opts.owner, opts.friendlyModel);
  const events = FIXTURE_EVENTS[opts.runKey];
  return [
    {
      delayMs: 300,
      events: [
        { type: 'agent_request_created', id: `req-${run.id}`, targetOwner: opts.owner, agent: opts.agent },
      ],
    },
    {
      delayMs: 200,
      events: [
        { type: 'session_started', runId: run.id, meta },
        { type: 'agent_busy_changed', agent: opts.agent, owner: opts.owner, busy: true },
        {
          type: 'message_created',
          id: `msg-ses-${run.id}`,
          seq: nextSeq(),
          kind: 'session',
          message: sessionMessage(opts.authorId, run.id, opts.time),
        },
      ],
    },
    ...sessionEventBeats(run.id, events, opts.perEventMs),
    {
      delayMs: 200,
      events: [{ type: 'agent_busy_changed', agent: opts.agent, owner: opts.owner, busy: false }],
    },
  ];
}

function say(authorId: PersonId, body: string, time: string): RoomFeedBeat {
  return {
    delayMs: 900,
    events: [
      {
        type: 'message_created',
        id: `msg-${authorId}-${time}`,
        seq: nextSeq(),
        kind: 'text',
        message: textMessage(authorId, body, time),
      },
    ],
  };
}

function typingThenSay(authorId: PersonId, body: string, time: string): RoomFeedBeat[] {
  return [
    { delayMs: 700, events: [{ type: 'typing_started', personId: authorId }] },
    {
      delayMs: 1100,
      events: [
        { type: 'typing_stopped', personId: authorId },
        {
          type: 'message_created',
          id: `msg-${authorId}-${time}`,
          seq: nextSeq(),
          kind: 'text',
          message: textMessage(authorId, body, time),
        },
      ],
    },
  ];
}

export function buildRoomFeed(): RoomFeedScript {
  seqCounter = 0;
  msgCounter = 0;

  const initialSnapshot: RoomSnapshot = {
    name: '#launch-numbers',
    ready: true,
    members: [PEOPLE.bob],
    agents: [],
    connectors: [],
    skills: [],
    messages: [],
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
  };

  const beats: RoomFeedBeat[] = [];
  const push = (...bs: RoomFeedBeat[]) => beats.push(...bs);

  // ── Chapter 1: Bob opens a space and invites Alice ──
  push(
    { delayMs: 400, events: [{ type: 'space_ready_changed', ready: false }] },
    say('bob', '@claude invite alice@acme.com to edit', '14:02'),
    {
      delayMs: 600,
      events: [
        { type: 'member_invited', who: 'alice', by: 'bob', inviteId: 'inv-alice' },
        {
          type: 'message_created',
          id: 'msg-invite-alice',
          seq: nextSeq(),
          kind: 'invite',
          message: inviteMessage('bob', 'inv-alice', '14:02'),
        },
      ],
    }
  );

  // ── Chapter 2: one question, Alice joins ──
  push(say('bob', '@alice how are we looking on the launch numbers?', '14:03'));
  push({
    delayMs: 1200,
    events: [
      { type: 'member_joined', id: 'alice' },
      { type: 'invite_status_changed', inviteId: 'inv-alice', status: 'joined' },
      {
        type: 'message_created',
        id: 'msg-join-alice',
        seq: nextSeq(),
        kind: 'system',
        message: systemMessage('alice', 'joined', '14:06'),
      },
    ],
  });
  push(
    ...typingThenSay(
      'alice',
      "Nothing's wired up yet. Give me ten minutes and you can ask this space yourself.",
      '14:06'
    )
  );

  // ── Chapter 3: Alice connects tools and has Codex write the skill ──
  push({
    delayMs: 1000,
    events: [
      { type: 'connector_added', connector: CONNECTORS.metabase },
      { type: 'connector_added', connector: CONNECTORS.mixpanel },
      {
        type: 'message_created',
        id: 'msg-connectors',
        seq: nextSeq(),
        kind: 'system',
        message: systemMessage(
          'alice',
          'connectors_added',
          '14:07',
          'Connected Metabase and Mixpanel to this space, read-only.',
          ['metabase', 'mixpanel']
        ),
      },
    ],
  });
  push(
    ...typingThenSay(
      'alice',
      '@codex write a launch-review skill for this space. Signups from Metabase, activation from the Mixpanel onboarding funnel. Each run writes a dated review to reviews/.',
      '14:09'
    )
  );
  push(
    ...sessionMoment({
      requester: 'alice',
      owner: 'alice',
      agent: 'codex',
      runKey: 'run-b-codex',
      friendlyModel: 'gpt-5-codex',
      authorId: 'alice',
      time: '14:09',
      perEventMs: 90,
    })
  );
  push({
    delayMs: 400,
    events: [
      { type: 'skill_added', skill: SKILL_LAUNCH_REVIEW },
      {
        type: 'message_created',
        id: 'msg-skill-added',
        seq: nextSeq(),
        kind: 'system',
        message: systemMessage(
          'alice',
          'skill_added',
          '14:11',
          'Added the launch-review skill — anyone here can run it as /launch-review.'
        ),
      },
    ],
  });
  push(
    ...typingThenSay(
      'alice',
      '@bob all set. Type /launch-review for the full picture, or just ask it anything about the launch.',
      '14:12'
    )
  );

  // ── Chapter 4: Bob runs it himself, Monday ──
  push(say('bob', '/launch-review', '14:15'));
  push(
    ...sessionMoment({
      requester: 'bob',
      owner: 'bob',
      agent: 'claude',
      runKey: 'run-c2-claude-bigoutput',
      friendlyModel: 'opus-5',
      authorId: 'bob',
      time: '14:15',
      perEventMs: 90,
    })
  );
  push(say('bob', '41% activation, way above plan. Nice.', '14:17'));

  // ── Chapter 5: Alice catches a counting bug and reruns ──
  push(
    ...typingThenSay(
      'alice',
      "@codex that 41% includes us: the @acme.com accounts and the loadtest-* users. Exclude both in the skill and rerun today's review.",
      '14:39'
    )
  );
  push(
    ...sessionMoment({
      requester: 'alice',
      owner: 'alice',
      agent: 'codex',
      runKey: 'run-b2-codex-planned',
      friendlyModel: 'gpt-5-codex',
      authorId: 'alice',
      time: '14:40',
      perEventMs: 90,
    })
  );
  push(
    ...typingThenSay(
      'alice',
      '@bob fixed. Internal accounts were inflating activation; the real number is 34%, still above our 30% plan.',
      '14:43'
    )
  );

  // ── Chapter 6: the next morning ──
  push({
    delayMs: 800,
    events: [
      {
        type: 'message_created',
        id: 'msg-day-divider',
        seq: nextSeq(),
        kind: 'system',
        message: systemMessage('bob', 'day_divider', '09:00', 'Tuesday, Sep 23'),
      },
    ],
  });
  push(say('bob', '/launch-review', '09:12'));
  push(
    ...sessionMoment({
      requester: 'bob',
      owner: 'bob',
      agent: 'claude',
      runKey: 'run-c-claude-bigoutput',
      friendlyModel: 'opus-5',
      authorId: 'bob',
      time: '09:12',
      perEventMs: 90,
    })
  );

  // ── Chapter 7: a question lands as a comment, an agent answers in the doc ──
  push({
    delayMs: 1200,
    events: [
      {
        type: 'message_created',
        id: 'msg-cmt-1',
        seq: nextSeq(),
        kind: 'comment_mirror',
        message: commentMirrorMessage(
          'bob',
          'cm1',
          'reviews/2026-09-23.md',
          'Paid signups are down 38% from Friday to Monday…',
          'is this paid only? If organic is flat, say so in the flag.',
          '09:20'
        ),
      },
      { type: 'agent_busy_changed', agent: 'claude', owner: 'bob', busy: true },
    ],
  });
  push({
    delayMs: 1800,
    events: [
      { type: 'agent_busy_changed', agent: 'claude', owner: 'bob', busy: false },
      {
        type: 'message_created',
        id: 'msg-cmt-1-reply',
        seq: nextSeq(),
        kind: 'comment_mirror',
        message: commentMirrorMessage(
          'bob',
          'cm1',
          'reviews/2026-09-23.md',
          'Paid signups are down 38% from Friday to Monday…',
          'Paid only. Organic signups are flat over the same days (+2%), so I added that to the flag.',
          '09:22',
          'claude'
        ),
      },
    ],
  });

  // ── Chapter 8: the CMO explains ──
  push(say('bob', '@claude invite carol@acme.com, she should look at the paid drop', '09:15'));
  push({
    delayMs: 600,
    events: [
      { type: 'member_invited', who: 'carol', by: 'bob', inviteId: 'inv-carol' },
      {
        type: 'message_created',
        id: 'msg-invite-carol',
        seq: nextSeq(),
        kind: 'invite',
        message: inviteMessage('bob', 'inv-carol', '09:15'),
      },
    ],
  });
  push({
    delayMs: 1200,
    events: [
      { type: 'member_joined', id: 'carol' },
      { type: 'invite_status_changed', inviteId: 'inv-carol', status: 'joined' },
      {
        type: 'message_created',
        id: 'msg-join-carol',
        seq: nextSeq(),
        kind: 'system',
        message: systemMessage('carol', 'joined', '09:31'),
      },
    ],
  });
  push(
    ...typingThenSay(
      'carol',
      '@claude catching up: Bob said activation was 41% on Monday, why is it 34% now?',
      '09:32'
    )
  );
  push(
    ...sessionMoment({
      requester: 'carol',
      owner: 'carol',
      agent: 'claude',
      runKey: 'run-a-claude',
      friendlyModel: 'sonnet-5',
      authorId: 'carol',
      time: '09:32',
      perEventMs: 90,
    })
  );
  push(
    ...typingThenSay(
      'carol',
      "The paid drop is us: we paused the Google Ads brand campaign Friday to redo the creatives. @codex pull last week's spend and paid signups from Google Ads and add them to today's review.",
      '09:34'
    )
  );
  push(
    ...sessionMoment({
      requester: 'carol',
      owner: 'carol',
      agent: 'codex',
      runKey: 'run-c-codex-bigoutput',
      friendlyModel: 'gpt-5-codex',
      authorId: 'carol',
      time: '09:34',
      perEventMs: 90,
    })
  );
  push(
    say('carol', '@bob added the relaunch date to the review. Paid should recover by Friday.', '09:38')
  );

  return { initialSnapshot, beats, reduce: reduceRoom };
}
