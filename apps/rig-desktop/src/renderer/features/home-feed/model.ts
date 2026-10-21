import type { DotMatrixState } from '@renderer/lib/ui/dot-matrix';

/**
 * The new Home's data model (docs: rig `README.md` §2 "Two screens", and
 * `docs/orchestrator-design.md` §6.1, §6.2, §7.1 and §11.4b).
 *
 * The rail shows spaces and their sessions; the Feed shows proposals and open
 * asks as items that each resolve to one verb. These types are the seam the
 * relay's `sessions` and `proposals` rows will plug into later: today the Feed
 * and the scripted chat come from `mock.ts`, and the rail merges real spaces
 * from `rpc.rig.recent` with that mock.
 */

// ── sessions (§6.1, §7.1) ───────────────────────────────────────────────────

/** A session's lifecycle state, as the orchestrator design names it. */
export type SessionState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'needs_you'
  | 'waiting_on_person'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'
  /** A chat that isn't running (the app's own local sessions): nothing to report. */
  | 'idle';

/** What a running session is doing right now, from its last tool kind. */
export type SessionActivity =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'planning';

/** The connectors a source can come from in this preview. */
export type SourceConnector = 'linear' | 'github' | 'granola';

export interface SourceRef {
  connector: SourceConnector;
  /** What the connector is scoped to: "Ulys", "rig-xyz/rig-ide", "your meetings". */
  scope: string;
  /** The item it points at: "ULY-429", "16 tickets", "Inbox · Earn Vault Bugs". */
  ref: string;
}

export interface Person {
  id: string;
  name: string;
  /** What hovering the face says: "Riyad Hasanov · owns account restrictions". */
  note?: string;
  /** Which face color their initial sits on when there's no photo (`--face-1`…`--face-7`). */
  hue: number;
  /** Their account photo, when they have one: shown instead of the initial. */
  avatarUrl?: string | null;
}

export interface ActivityStep {
  text: string;
  /** "2m", "7h", "now"; only the latest step shows one. */
  ago?: string;
}

export interface RailSession {
  id: string;
  spaceId: string;
  name: string;
  state: SessionState;
  activity?: SessionActivity;
  /** The few words under the name in the rail: "Needs you", "Done · 16 to review". */
  short: string;
  /** One line for the hover card and the context view's header. */
  summary: string;
  /** The latest step, for the hover card and the status block. */
  last: { who: string; text: string; ago: string };
  steps: ActivityStep[];
  source?: SourceRef;
  /** Whose Claude runs it, when it isn't yours. */
  owner?: string;
  /** Session ids that come from the app's own `session_runs` (real) vs the preview's mock. */
  origin: 'real' | 'mock';
  /** Set when the session was just created from the Feed or the chat: it lands with a pulse. */
  fresh?: boolean;
}

export interface RailSpace {
  id: string;
  name: string;
  /** Only you: a lock. Shared: faces. */
  visibility: 'private' | 'shared';
  faces: Person[];
  unread: number;
  summary: string;
  sessions: RailSession[];
  /** Where the space lives on disk, when it is one of the app's real spaces. */
  root?: string;
  bindingId?: string;
  origin: 'real' | 'mock';
  fresh?: boolean;
}

// ── proposals and Feed items (§6.2, §11.4b) ─────────────────────────────────

/** Every Feed item resolves to one of these, so the button says what really happens. */
export type FeedVerb = 'reply' | 'start' | 'space' | 'open';

export type ProposalKind = 'session' | 'background' | 'space' | 'reply' | 'ask' | 'extension';

export type ProposalStatus = 'shown' | 'held' | 'accepted' | 'snoozed' | 'dismissed' | 'expired';

/** Needs you: asks and reviews. Up next: suggestions and replies. */
export type FeedGroup = 'needs_you' | 'up_next';

/** Where acting on a choice lands. */
export type ChoiceTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'new-session'; spaceId: string; background?: boolean }
  | { kind: 'new-space'; name: string; people: string[]; fromSessionId?: string };

export interface FeedChoice {
  id: string;
  /** Short name, for the carousel dot's tooltip and its spoken label. */
  label: string;
  verb: FeedVerb;
  /**
   * The proposal text for this choice, with tokens: `{@Riyad}` a person,
   * `{#rig-marketing}` a space, `{new space}` a space this would create,
   * anything else a ticket or item ref. `lead` is the action, said in bold.
   */
  lead: string;
  /** What the choice means, said after the item's context. */
  tail: string;
  target: ChoiceTarget;
}

export interface FeedItem {
  /** `prp_…` for a proposal, `ask_…` for an open ask. */
  id: string;
  kind: ProposalKind;
  group: FeedGroup;
  status: ProposalStatus;
  title: string;
  /** The context sentence, in the data's words, with tokens. */
  why: string;
  choices: FeedChoice[];
  /** The space the item is about, in one word, when the chosen verb doesn't name another. */
  spaceId: string;
  /** The session that asked (asks and reviews), if any. */
  sessionId?: string;
  source?: SourceRef;
  /** People involved, shown as overlapping faces next to the source. */
  people: string[];
  /** Hover explanations for tokens in the text: `{new space}` → what it would share. */
  tokenNotes: Record<string, string>;
  /** A draft brief exists, so the menu offers "Edit the brief first". */
  hasBrief: boolean;
  /** "2m", "new", "8d". */
  age: string;
  /** The goal line the brief would carry, for the brief view. */
  plan?: string;
}

// ── state → DotMatrix ───────────────────────────────────────────────────────

export type MatrixTone = 'accent' | 'warn' | 'ok' | 'mute';

/** The matrix state and tone a session shows (§7.1's dot-matrix mapping). */
export function sessionMatrix(session: Pick<RailSession, 'state' | 'activity'>): {
  state: DotMatrixState;
  tone: MatrixTone;
} {
  switch (session.state) {
    case 'queued':
      return { state: 'queued', tone: 'mute' };
    case 'starting':
      return { state: 'starting', tone: 'accent' };
    case 'running':
      return { state: session.activity ?? 'thinking', tone: 'accent' };
    case 'needs_you':
      return { state: 'waiting', tone: 'warn' };
    case 'waiting_on_person':
      return { state: 'waiting', tone: 'mute' };
    case 'paused':
      return { state: 'stopped', tone: 'mute' };
    case 'done':
      return { state: 'done', tone: 'ok' };
    case 'failed':
      return { state: 'failed', tone: 'accent' };
    case 'cancelled':
      return { state: 'stopped', tone: 'mute' };
    case 'idle':
      return { state: 'idle', tone: 'accent' };
  }
}

/** The tone the few words under a session's name take in the rail. */
export function sessionLabelTone(state: SessionState): 'warn' | 'ok' | 'muted' {
  if (state === 'needs_you') return 'warn';
  if (state === 'done') return 'ok';
  return 'muted';
}

/** The status word the hover card and context view show at the right. */
export function sessionStatusWord(state: SessionState): {
  text: string;
  tone: 'warn' | 'live' | 'ok' | 'muted';
} {
  switch (state) {
    case 'needs_you':
      return { text: 'Needs you', tone: 'warn' };
    case 'done':
      return { text: 'Done', tone: 'ok' };
    case 'waiting_on_person':
      return { text: 'Waiting', tone: 'muted' };
    case 'starting':
      return { text: 'Starting', tone: 'live' };
    case 'queued':
      return { text: 'Scheduled', tone: 'muted' };
    case 'paused':
      return { text: 'Paused', tone: 'muted' };
    case 'failed':
      return { text: 'Failed', tone: 'warn' };
    case 'cancelled':
      return { text: 'Stopped', tone: 'muted' };
    case 'running':
      return { text: 'Working', tone: 'live' };
    case 'idle':
      return { text: 'Idle', tone: 'muted' };
  }
}
