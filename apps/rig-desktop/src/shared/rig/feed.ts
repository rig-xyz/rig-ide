import { defineEvent } from '@shared/lib/ipc/events';

/**
 * The orchestrator's Feed, as the relay serves it (`GET /v1/me/feed`, tap
 * relay routes/orchestrator.ts; rig docs/orchestrator-architecture.md §4.6).
 * A card is one situation: an open loop Rig noticed, with Rig's latest
 * decision about it and, for visible cards, a drafted card.
 */

/** What Rig decided to do about a situation (Decide's `do`). */
export type RigDecisionDo =
  | 'nothing'
  | 'digest'
  | 'ask_you'
  | 'do_it'
  | 'bring_in'
  | 'keep_watching'
  | 'close';

export type RigDecision = {
  do: RigDecisionDo;
  /** Jev's confidence in `do`, 0–1. */
  conf: number;
  who: string;
  look: string;
  trigger: string;
};

export type RigFeedChoice = { verb: 'reply' | 'start' | 'space' | 'open'; label: string; lead: string; tail: string };

export type RigFeedCard = {
  /** Up to three options, best first; `lead` and `why` may hold {@Full Name} tokens. */
  choices: RigFeedChoice[];
  /** The people the card is about. */
  people: string[];
  title: string;
  /** One or two sentences citing refs in square brackets: `[item:ULY-280]`, `[msg:…]`. */
  why: string;
  /** The proposed action, starting with the verb in bold: `**Reply to Riyad.** …`. */
  action: string;
  refsOk: boolean;
};

export type RigFeedItem = {
  situationId: string;
  /** Where its events came from: linear, slack, gmail, room, session… */
  sources: string[];
  /** The Space its events came from, when any did. */
  bindingId: string | null;
  title: string;
  description: string;
  participants: string[];
  decision: RigDecision | null;
  card: RigFeedCard | null;
  updatedAt: string;
};

export type RigFeed = {
  /** How Rig names the person (their preference card), for when the account has no name. */
  me: string | null;
  visible: RigFeedItem[];
  queued: RigFeedItem[];
  following: RigFeedItem[];
  snoozed: RigFeedItem[];
  digest: { title: string; source?: string; at?: string }[];
};

export type RigSituationEvent = {
  id: string;
  ref: string;
  source: string;
  from: string | null;
  title: string;
  summary: string;
  excerpt: string;
  /** Where the event lives (a permalink, a PR or ticket URL), when its source gave one. */
  url: string | null;
  at: string;
  /** How the event got here: by fact, by Jev, a new situation, the gardener, or a correction. */
  attachedBy: string;
};

export type RigSituation = {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'closed' | 'merged';
  participants: string[];
  decision: RigDecision | null;
  events: RigSituationEvent[];
  /** "Why is this here?" in plain words. */
  explain: string | null;
};

/** The person's answer to a card. */
export type RigFeedSignal = 'act' | 'ignore' | 'snooze';

/** Who made a correction: the person, or an agent ("Dylan's Claude"). */
export type RigFeedActor = string;

/** The Feed changed on the relay (`feed_changed` on the notification stream, or a local answer). */
export const rigFeedChangedChannel = defineEvent<{ reason: 'relay' | 'local' }>('rig:feed-changed');

/**
 * A session in a space's folder (its own conversation, listed under the
 * space's Sessions) that Rig starts for the person: a new one, or a
 * situation's latest continued for a follow-up.
 */
export type RigSessionStart = {
  sessionId: string;
  continue: boolean;
  bindingId: string;
  root: string;
  prompt: string;
  title: string;
  situationId: string | null;
  /** Ask first: the session asks before anything it does (a card's Reply). Otherwise the space's own mode. */
  askFirst?: boolean;
};

/** Main asks the window to start or continue a space session: chat sessions live in the window (rig-session-registry.ts). */
export const rigStartSessionChannel = defineEvent<RigSessionStart>('rig:start-session');
