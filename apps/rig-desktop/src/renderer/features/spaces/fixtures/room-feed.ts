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

import type { RigNotification } from '@shared/rig/notifications';
import type { RoomFeedBeat, RoomFeedScript } from '../room-source';
import { applyThemeEvents, themesFromSnapshot, type ThemeEvent } from '../themes';
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

    case 'older_messages_loading':
      return { ...snapshot, olderMessages: 'loading' };

    case 'older_messages_loaded': {
      // Older pages go in front, in seq order, minus anything already here
      // (a page can overlap what a catch-up just brought in).
      const have = new Set(snapshot.messages.map((m) => m.id));
      const older = event.messages.filter((m) => !have.has(m.id)).sort((a, b) => a.seq - b.seq);
      return {
        ...snapshot,
        messages: older.length > 0 ? [...older, ...snapshot.messages] : snapshot.messages,
        olderMessages: event.more ? 'more' : 'none',
      };
    }

    case 'reactions_changed': {
      let changed = false;
      const messages = snapshot.messages.map((m) => {
        const next = event.reactions[m.id];
        if (!next) return m;
        changed = true;
        const { reactions: _old, ...rest } = m;
        return next.length > 0 ? { ...rest, reactions: next } : rest;
      });
      return changed ? { ...snapshot, messages } : snapshot;
    }

    case 'themes_synced':
      return { ...snapshot, themes: themesFromSnapshot(event.snapshot) };

    case 'themes_applied': {
      if (!snapshot.themes) return snapshot;
      let seqs: Map<string, number> | null = null;
      const next = applyThemeEvents(snapshot.themes, event.events, event.upTo, (messageId) => {
        seqs ??= new Map(snapshot.messages.map((m) => [m.id, m.seq]));
        return seqs.get(messageId);
      });
      return next === snapshot.themes ? snapshot : { ...snapshot, themes: next };
    }

    case 'themes_cleared':
      return snapshot.themes == null ? snapshot : { ...snapshot, themes: null };

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
      let next = { ...started, sessionEventsByRun: { ...started.sessionEventsByRun, [event.runId]: event.events } };
      // The log replaces a summary shown from disk.
      if (snapshot.sessionSummaryByRun?.[event.runId]) {
        const { [event.runId]: _summary, ...sessionSummaryByRun } = snapshot.sessionSummaryByRun;
        next = { ...next, sessionSummaryByRun };
      }
      if (!snapshot.runsLoading?.[event.runId]) return next;
      const { [event.runId]: _loaded, ...runsLoading } = snapshot.runsLoading;
      return { ...next, runsLoading };
    }

    case 'session_meta_updated': {
      const meta = snapshot.sessionMetaByRun[event.runId];
      if (!meta) return snapshot;
      return { ...snapshot, sessionMetaByRun: { ...snapshot.sessionMetaByRun, [event.runId]: { ...meta, ...event.meta } } };
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

    case 'room_caught_up':
      return { ...snapshot, stale: false };

    case 'relay_reachability_changed':
      return { ...snapshot, relayUnreachable: event.unreachable };

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

export function buildRoomFeed(options: { dock?: boolean } = {}): RoomFeedScript {
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
    ...typingThenSay(
      'carol',
      '@bob added the relaunch date to the review. Paid should recover by Friday.',
      '09:38'
    )
  );

  if (options.dock) return withDockDemo({ initialSnapshot, beats, reduce: reduceRoom });
  return { initialSnapshot, beats, reduce: reduceRoom };
}

// ────────── the dock demo ──────────

const DEMO_THEMES = {
  setup: {
    name: 'Space setup',
    description: 'Inviting people, connecting the tools, the launch-review skill.',
  },
  launch: {
    name: 'Launch numbers',
    description: 'Signups and activation for the launch, from Metabase and Mixpanel.',
  },
  activation: {
    name: 'Activation count',
    description: 'Why activation read 41% and what the real number is.',
  },
  paid: { name: 'Paid signups', description: 'The Friday to Monday drop and what caused it.' },
} as const;
type DemoThemeId = keyof typeof DEMO_THEMES;

const DEMO_RUN_ID = 'run-demo-approval';

/** The theme each run's card belongs to, by run id. */
const RUN_THEME = new Map<string, DemoThemeId>([
  [fixtureRun('run-b-codex').id, 'setup'],
  [fixtureRun('run-c2-claude-bigoutput').id, 'launch'],
  [fixtureRun('run-b2-codex-planned').id, 'activation'],
  [fixtureRun('run-c-claude-bigoutput').id, 'launch'],
  [fixtureRun('run-a-claude').id, 'activation'],
  [fixtureRun('run-c-codex-bigoutput').id, 'paid'],
  [DEMO_RUN_ID, 'paid'],
]);

/** Which demo theme a message belongs to, or none. */
function demoThemeOf(message: RoomMessage): DemoThemeId | null {
  const { meta } = message;
  const body = message.body ?? '';
  if (meta.kind === 'session') return RUN_THEME.get(meta.runId) ?? 'launch';
  if (meta.kind === 'comment_mirror') return 'paid';
  if (meta.kind === 'invite') return meta.inviteId === 'inv-carol' ? 'paid' : 'setup';
  if (meta.kind === 'system') return meta.event === 'day_divider' ? null : 'setup';
  if (/invite carol|Friday paid|paid drop is us|relaunch date/.test(body)) return 'paid';
  if (/41% includes us|Internal accounts|why is it 34/.test(body)) return 'activation';
  if (/invite alice|wired up|launch-review skill|all set/.test(body)) return 'setup';
  return 'launch';
}

function demoPermission(seq: number, requestId: string, title: string): SessionEvent[] {
  return [
    {
      seq,
      kind: 'tool_call',
      payload: { toolCallId: `t-${requestId}`, title, kind: 'execute', status: 'pending' },
    },
    {
      seq: seq + 1,
      kind: 'permission_requested',
      payload: {
        requestId,
        toolCall: { toolCallId: `t-${requestId}`, title },
        options: [
          { optionId: `${requestId}-no`, name: 'No', kind: 'reject_once' },
          { optionId: `${requestId}-always`, name: 'Always allow', kind: 'allow_always' },
          { optionId: `${requestId}-yes`, name: 'Yes', kind: 'allow_once' },
        ],
      },
    },
  ];
}

/**
 * The scripted demo with the dock filled in, for looking at it without a
 * relay: four themes sorted as the messages arrive, a run of Bob's waiting on
 * two approvals, and two asks of Bob. The asks and the request come as inbox
 * rows (`notifications`), as they would from the relay.
 */
function withDockDemo(script: RoomFeedScript): RoomFeedScript {
  const beats = [...script.beats];

  // Bob asks his agent for something that needs approval.
  const ask = say('bob', '@claude compare Friday paid signups with the relaunch numbers', '09:41');
  const meta: SessionRunMeta = {
    id: DEMO_RUN_ID,
    agent: 'claude',
    owner: 'bob',
    model: 'opus-5',
    title: 'Compare Friday paid signups',
    status: 'running',
    startedAt: '2026-09-23T16:40:00-04:00',
    endedAt: null,
  };
  beats.push(
    ask,
    {
      delayMs: 400,
      events: [
        { type: 'session_started', runId: DEMO_RUN_ID, meta },
        { type: 'agent_busy_changed', agent: 'claude', owner: 'bob', busy: true },
        {
          type: 'message_created',
          id: `msg-ses-${DEMO_RUN_ID}`,
          seq: nextSeq(),
          kind: 'session',
          message: sessionMessage('bob', DEMO_RUN_ID, '09:41'),
        },
      ],
    },
    {
      delayMs: 700,
      events: [
        ...demoPermission(1, 'demo-req-1', 'Query Google Ads spend for last week'),
        ...demoPermission(3, 'demo-req-2', 'Write reviews/paid-recovery.md'),
      ].map((event) => ({
        type: 'session_event_appended' as const,
        runId: DEMO_RUN_ID,
        seq: event.seq,
        event,
      })),
    }
  );

  // Themes: a `born` the first time one is used, then an `assign` per message.
  let eventId = 0;
  const born = new Set<DemoThemeId>();
  const withThemes: RoomFeedBeat[] = beats.map((beat) => {
    const events: RoomEvent[] = [];
    for (const event of beat.events) {
      events.push(event);
      if (event.type !== 'message_created') continue;
      const themeId = demoThemeOf(event.message);
      if (!themeId) continue;
      const themeEvents: ThemeEvent[] = [];
      if (!born.has(themeId)) {
        born.add(themeId);
        themeEvents.push({
          id: String(++eventId),
          atSeq: event.message.seq,
          type: 'born',
          themeId,
          ...DEMO_THEMES[themeId],
          bornSeq: event.message.seq,
        });
      }
      themeEvents.push({
        id: String(++eventId),
        atSeq: event.message.seq,
        type: 'assign',
        messageId: event.message.id,
        themeId,
        via: 'jev',
      });
      events.push({ type: 'themes_applied', events: themeEvents, upTo: themeEvents.at(-1)!.id });
    }
    return { ...beat, events };
  });

  const messageIdOf = (needle: string): string => {
    for (const beat of withThemes) {
      for (const event of beat.events) {
        if (event.type === 'message_created' && event.message.body?.includes(needle))
          return event.message.id;
      }
    }
    throw new Error(`demo message not found: ${needle}`);
  };
  const carol = { kind: 'user' as const, userId: 'carol', name: 'Carol', agent: null };
  const alice = { kind: 'user' as const, userId: 'alice', name: 'Alice', agent: null };
  const row = (
    id: string,
    bindingId: string,
    type: RigNotification['type'],
    actor: RigNotification['actor'],
    extra: Partial<RigNotification>
  ): RigNotification => ({
    id,
    type,
    tier: 'direct',
    bindingId,
    spaceName: '#launch-numbers',
    actor,
    messageId: null,
    messageSeq: null,
    runId: null,
    requestId: null,
    inviteId: null,
    path: null,
    title: '',
    body: '',
    createdAt: '2026-09-23T13:40:00.000Z',
    readAt: null,
    ...extra,
  });

  return {
    ...script,
    initialSnapshot: {
      ...script.initialSnapshot,
      themes: { enabled: true, list: [], themeOf: {}, cursor: '0' },
    },
    beats: withThemes,
    notifications: (bindingId) => [
      row('demo-ask-carol', bindingId, 'mention', carol, {
        messageId: messageIdOf('added the relaunch date'),
        body: '@bob added the relaunch date',
      }),
      row('demo-ask-alice', bindingId, 'mention', alice, {
        messageId: messageIdOf('Internal accounts were inflating'),
        body: '@bob fixed',
        createdAt: '2026-09-23T13:41:00.000Z',
      }),
      row('demo-request', bindingId, 'agent_request', carol, {
        runId: DEMO_RUN_ID,
        body: 'compare Friday paid signups',
        createdAt: '2026-09-23T13:42:00.000Z',
      }),
    ],
  };
}
