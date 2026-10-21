import type { FeedItem, Person, RailSpace, SourceConnector } from './model';

/**
 * The preview's data: the Feed's items and the demo sessions they're about,
 * as the orchestrator would send them (`docs/orchestrator-design.md` §6.2
 * proposals, §11.4b Feed items). Everything here gets replaced by relay rows
 * once the orchestrator exists; nothing outside this file and `orchestrator.ts`
 * knows the data is scripted.
 */

export const SOURCES: Record<SourceConnector, { name: string; scope: string }> = {
  linear: { name: 'Linear', scope: 'Ulys' },
  github: { name: 'GitHub', scope: 'rig-xyz/rig-ide' },
  granola: { name: 'Granola', scope: 'your meetings' },
};

/** Faces use `--face-1`…`--face-7`. */
export const PEOPLE: Record<string, Person> = {
  riyad: {
    id: 'riyad',
    name: 'Riyad Hasanov',
    note: 'Riyad Hasanov · owns account restrictions',
    hue: 2,
  },
  hugo: { id: 'hugo', name: 'Hugo Renaudin', hue: 1 },
  anthony: { id: 'anthony', name: 'Anthony', note: 'Anthony · 39 launch tickets', hue: 4 },
  natalie: { id: 'natalie', name: 'Natalie Jaeger', hue: 5 },
  harold: { id: 'harold', name: 'Harold Eytan', hue: 6 },
  janis: { id: 'janis', name: 'Janis', hue: 3 },
};

/** The spaces and sessions the Feed talks about. A real space with the same name takes their place. */
export function demoSpaces(): RailSpace[] {
  return [
    {
      id: 'ulys-backlog',
      name: 'ulys-backlog',
      visibility: 'private',
      faces: [],
      unread: 0,
      summary: 'Your Ulys Linear backlog, worked by Claude.',
      origin: 'mock',
      sessions: [
        {
          id: 's-triage',
          spaceId: 'ulys-backlog',
          name: 'Triage 3 urgent tickets',
          state: 'needs_you',
          short: 'Needs you',
          summary: 'Cause found for ULY-280, ULY-220 needs your call, ULY-429 needs Riyad.',
          last: {
            who: 'Claude',
            text: 'ULY-429 needs a call on the A7A5 restriction. Riyad owns account restrictions.',
            ago: '2m',
          },
          source: { connector: 'linear', scope: 'Ulys', ref: 'ULY-429' },
          origin: 'mock',
          steps: [
            { text: 'Read the brief: .rig/briefs/urgent-triage.md' },
            { text: 'Opened ULY-429, ULY-220 and ULY-280 in Linear' },
            { text: 'ULY-280: wallet_policies still holds the old Solana network id' },
            {
              text: 'ULY-220 needs a product call: support-led recovery, or self-serve with a KYC re-check',
            },
            {
              text: 'ULY-429 needs a call on the A7A5 restriction. Riyad owns account restrictions (ULY-495).',
              ago: '2m',
            },
          ],
        },
        {
          id: 's-stale',
          spaceId: 'ulys-backlog',
          name: 'Clear 115 stale tickets',
          state: 'done',
          short: 'Done · 16 to review',
          summary: 'Finished overnight: 61 closed, 38 kept with a note, 16 for you.',
          last: { who: 'Claude', text: 'Done: 61 closed · 38 kept · 16 for you', ago: '7h' },
          source: { connector: 'linear', scope: 'Ulys', ref: '16 tickets' },
          origin: 'mock',
          steps: [
            { text: 'Read the brief: .rig/briefs/stale-cleanup.md' },
            { text: 'Closed ULY-6 and ULY-7: Contacts paused, untouched 103 days' },
            { text: 'Kept ULY-11 with a note: invite flow is P0 for Phase 3' },
            { text: 'Done: 61 closed · 38 kept · 16 for you', ago: '7h' },
          ],
        },
      ],
    },
    {
      id: 'rig-ops',
      name: 'rig-ops',
      visibility: 'shared',
      faces: [],
      unread: 0,
      summary: 'Ops for Rig: usage, failures and the daily digest.',
      origin: 'mock',
      sessions: [
        {
          id: 's-domains',
          spaceId: 'rig-ops',
          name: 'Usage by email domain',
          state: 'running',
          activity: 'reading',
          owner: 'Hugo',
          short: '38 domains so far',
          summary: "Hugo's Claude is grouping sign-ups by company domain.",
          last: {
            who: "Hugo's Claude",
            text: 'Grouping 214 sign-ups: 38 domains so far',
            ago: 'now',
          },
          origin: 'mock',
          steps: [
            { text: 'Hugo asked: infer from the different email domains' },
            { text: 'Read 214 sign-ups from the account export' },
            { text: 'Grouping by domain: 38 so far', ago: 'now' },
          ],
        },
      ],
    },
    {
      id: 'rig-marketing',
      name: 'rig-marketing',
      visibility: 'shared',
      faces: [],
      unread: 3,
      summary: 'Hugo and Claude are drafting the investor deck and manifesto v2.',
      origin: 'mock',
      sessions: [],
    },
    {
      id: 'rig-feedback',
      name: 'rig-feedback',
      visibility: 'shared',
      faces: [],
      unread: 0,
      summary: 'Beta feedback and release notes.',
      origin: 'mock',
      sessions: [],
    },
    {
      id: 'rig-get-zwifty',
      name: 'rig-get-zwifty',
      visibility: 'shared',
      faces: [],
      unread: 0,
      summary: 'Janis is fixing Claude sign-in.',
      origin: 'mock',
      sessions: [],
    },
  ];
}

const NEW_SPACE_NOTE =
  "A new shared space made from this session: the brief, Claude's findings and the 3 tickets. Nothing else from your backlog is shared.";

function startChoices(spaceId: string, plan: string) {
  const lower = plan.replace(/^\w/, (m) => m.toLowerCase());
  return [
    {
      id: 'now',
      label: 'Now',
      verb: 'start' as const,
      lead: 'Start now',
      tail: `: ${lower}`,
      target: { kind: 'new-session' as const, spaceId },
    },
    {
      id: 'bg',
      label: 'In background',
      verb: 'start' as const,
      lead: 'Run it in the background',
      tail: `: ${lower} It reports when done.`,
      target: { kind: 'new-session' as const, spaceId, background: true },
    },
  ];
}

const EARN_PLAN =
  'Claude reads the new tickets, finds the root cause, and links or closes duplicates.';
const RELEASE_PLAN =
  'Claude follows the release runbook step by step and asks before each publish.';

export function demoFeed(): FeedItem[] {
  return [
    {
      id: 'ask_429',
      kind: 'ask',
      group: 'needs_you',
      status: 'shown',
      title: 'Decide on the A7A5 restriction',
      why: 'Claude found the causes of {ULY-280} and {ULY-220}. {ULY-429} needs a policy call: block A7A5 trading now, or wait.',
      spaceId: 'ulys-backlog',
      sessionId: 's-triage',
      source: { connector: 'linear', scope: 'Ulys', ref: 'ULY-429' },
      people: ['riyad'],
      tokenNotes: { '@Riyad': PEOPLE.riyad!.note!, 'new space': NEW_SPACE_NOTE },
      hasBrief: false,
      age: '2m',
      choices: [
        {
          id: 'bring',
          label: 'Ask Riyad',
          verb: 'space',
          lead: 'Ask {@Riyad} to decide',
          tail: ': he owns account restrictions and joins a {new space} with this triage.',
          target: {
            kind: 'new-space',
            name: 'urgent-triage',
            people: ['riyad'],
            fromSessionId: 's-triage',
          },
        },
        {
          id: 'block',
          label: 'Block it',
          verb: 'reply',
          lead: 'Block it now',
          tail: ': Claude drafts the change and shows you before applying it.',
          target: { kind: 'session', sessionId: 's-triage' },
        },
        {
          id: 'leave',
          label: 'Leave open',
          verb: 'reply',
          lead: 'Leave it open',
          tail: ': Claude notes the question on the ticket and wraps up.',
          target: { kind: 'session', sessionId: 's-triage' },
        },
      ],
    },
    {
      id: 'ask_review',
      kind: 'reply',
      group: 'needs_you',
      status: 'shown',
      title: 'Review 16 close calls',
      why: '61 tickets were closed overnight, each with a reason, and 38 were kept. Claude was unsure about 16.',
      spaceId: 'ulys-backlog',
      sessionId: 's-stale',
      source: { connector: 'linear', scope: 'Ulys', ref: '16 tickets' },
      people: [],
      tokenNotes: {},
      hasBrief: false,
      age: '7h',
      choices: [
        {
          id: 'one',
          label: 'One by one',
          verb: 'open',
          lead: 'Go through them one by one',
          tail: ": each comes with Claude's reason.",
          target: { kind: 'session', sessionId: 's-stale' },
        },
        {
          id: 'keep',
          label: 'Keep all',
          verb: 'reply',
          lead: 'Keep all 16 closed',
          tail: '.',
          target: { kind: 'session', sessionId: 's-stale' },
        },
        {
          id: 'reopen',
          label: 'Reopen all',
          verb: 'reply',
          lead: 'Reopen all 16',
          tail: ', each with a note.',
          target: { kind: 'session', sessionId: 's-stale' },
        },
      ],
    },
    {
      id: 'prp_earn',
      kind: 'session',
      group: 'up_next',
      status: 'shown',
      title: 'Triage the new Earn bugs',
      why: 'Two Earn bugs arrived since Friday, and {ULY-523} looks like {ULY-245}.',
      spaceId: 'ulys-backlog',
      source: { connector: 'linear', scope: 'Ulys', ref: 'Earn Vault Bugs' },
      topicId: 'earn',
      people: [],
      tokenNotes: {},
      hasBrief: true,
      age: 'new',
      plan: EARN_PLAN,
      choices: startChoices('ulys-backlog', EARN_PLAN),
    },
    {
      id: 'prp_release',
      kind: 'session',
      group: 'up_next',
      status: 'shown',
      title: 'Finish the 0.4.15 release',
      why: 'The 0.4.15 release has been a draft for 7 days and its tag was never pushed.',
      spaceId: 'rig-feedback',
      source: { connector: 'github', scope: 'rig-xyz/rig-ide', ref: 'Desktop Release' },
      topicId: 'release',
      people: [],
      tokenNotes: {},
      hasBrief: true,
      age: '1d',
      plan: RELEASE_PLAN,
      choices: startChoices('rig-feedback', RELEASE_PLAN),
    },
    {
      id: 'prp_hugo',
      kind: 'reply',
      group: 'up_next',
      status: 'shown',
      title: 'Reply to Hugo on manifesto v2',
      why: '{@Hugo} asked twice what you think of “Everyone is a builder now” vs “The Loop”.',
      spaceId: 'rig-marketing',
      people: ['hugo'],
      tokenNotes: { '@Hugo': PEOPLE.hugo!.name },
      hasBrief: false,
      age: '8d',
      plan: 'Claude reads both versions and drafts a reply in your voice for you to edit.',
      choices: [
        {
          id: 'draft',
          label: 'Draft reply',
          verb: 'start',
          lead: 'Draft a reply',
          tail: ' in your voice for you to edit.',
          target: { kind: 'new-session', spaceId: 'rig-marketing' },
        },
        {
          id: 'sum',
          label: 'Compare first',
          verb: 'start',
          lead: 'Compare both versions first',
          tail: ', then draft a reply.',
          target: { kind: 'new-session', spaceId: 'rig-marketing' },
        },
        {
          id: 'self',
          label: 'Myself',
          verb: 'open',
          lead: 'Reply myself',
          tail: ' in {#rig-marketing}.',
          target: { kind: 'space', spaceId: 'rig-marketing' },
        },
      ],
    },
    {
      id: 'prp_loyalty',
      kind: 'space',
      group: 'up_next',
      status: 'shown',
      title: 'Give Season 1 Loyalty its own space',
      why: '42 launch tickets across {@Anthony}, {@Natalie} and {@Harold}, launching Oct 25.',
      spaceId: 'ulys-backlog',
      source: { connector: 'linear', scope: 'Ulys', ref: 'Season 1 Loyalty Launch' },
      topicId: 'loyalty',
      people: ['anthony', 'natalie', 'harold'],
      tokenNotes: {
        '@Anthony': PEOPLE.anthony!.note!,
        '@Natalie': PEOPLE.natalie!.name,
        '@Harold': PEOPLE.harold!.name,
      },
      hasBrief: false,
      age: 'new',
      plan: 'Rig makes a shared space with the tickets; Claude posts a daily status until launch.',
      choices: [
        {
          id: 'space',
          label: 'Shared space',
          verb: 'space',
          lead: 'Make a shared space',
          tail: ' with them; Claude posts a daily status until launch.',
          target: {
            kind: 'new-space',
            name: 'season-1-loyalty',
            people: ['anthony', 'natalie', 'harold'],
          },
        },
        {
          id: 'solo',
          label: 'Just me',
          verb: 'start',
          lead: 'Just watch it for me',
          tail: ' in {#ulys-backlog}.',
          target: { kind: 'new-session', spaceId: 'ulys-backlog' },
        },
      ],
    },
  ];
}

/** The item a watch session promotes into the Feed while you're on Home (the Connectors script's last check). */
export const ARRIVAL = {
  item: (): FeedItem => ({
    id: 'prp_claims',
    kind: 'session',
    group: 'up_next',
    status: 'shown',
    title: 'Look into requests stuck after sign-out',
    why: 'Two GitHub issues in an hour: {rig-ide#212} retries forever after a sign-in failure, and {rig-ide#213} stays queued when the only Mac signs out.',
    spaceId: 'rig-feedback',
    source: { connector: 'github', scope: 'rig-xyz/rig-ide', ref: 'Spaces Reliability' },
    topicId: 'spaces',
    people: [],
    tokenNotes: { 'rig-ide#212': 'GitHub issue', 'rig-ide#213': 'GitHub issue' },
    hasBrief: true,
    age: 'just now',
    plan: 'Claude reads the claim poller, finds the cause, and drafts a fix plan for you to review.',
    choices: startChoices(
      'rig-feedback',
      'Claude reads the claim poller, finds the cause, and drafts a fix plan for you to review.'
    ),
  }),
};

/** A suggestion Rig makes from a topic you asked to see in your Feed. */
export function topicSuggestion(topic: {
  id: string;
  name: string;
  count: number;
  connector: SourceConnector;
}): FeedItem {
  const plan =
    'Claude reads the items, finds what they have in common, and drafts a plan for you to review.';
  return {
    id: `prp_topic_${topic.id}`,
    kind: 'session',
    group: 'up_next',
    status: 'shown',
    title: `Look into ${topic.name}`,
    why: `${topic.count} items from ${SOURCES[topic.connector].name} sorted into ${topic.name}.`,
    spaceId: 'rig-feedback',
    source: { connector: topic.connector, scope: SOURCES[topic.connector].scope, ref: topic.name },
    topicId: topic.id,
    people: [],
    tokenNotes: {},
    hasBrief: true,
    age: 'just now',
    plan,
    choices: startChoices('rig-feedback', plan),
  };
}
