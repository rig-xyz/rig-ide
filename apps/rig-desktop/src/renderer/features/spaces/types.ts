/**
 * Spaces (lane 2): shared types for the Room UI, built against a recorded
 * feed (no relay dependency yet — see `room-source.ts` and `NOTES.md` for
 * what lane 3's `RelayRoomSource` will need to satisfy this contract).
 *
 * A space is a rig whose front door is a shared "Room": people chat in
 * bubbles, each person's own coding agent (Claude or Codex) works in the
 * open as a live session card, and runs produce documents. This file only
 * describes the SHAPE of that room — no rendering, no transport.
 */

import type { MessageAttachment } from '@shared/rig/attachments';
import type { ConnectionState, ConnectorGap, RigToolArgs } from '@shared/spaces/connectors';
import type { RunSummary } from '@shared/spaces/room-cache';
import type { RoomSees } from '@shared/spaces/room-sees';
import type { MessageReaction } from '@shared/spaces/reactions';
import type { ThemeEvent, ThemesSnapshotWire } from '@shared/spaces/themes';
import type { RoomThemes } from './themes';

export type PersonId = string;
export type AgentKind = 'claude' | 'codex';

/** A human participant in the space. */
export interface RoomMember {
  id: PersonId;
  name: string;
  email: string;
  /** Short role label shown next to invites, e.g. "CEO" — mirrors the demo's role chip. */
  role: string;
  /** Single-letter (or short) initial used when no avatar image is available. */
  initial: string;
  /** Profile photo, when the person has one. */
  avatarUrl?: string | null;
  status: 'here' | 'invited';
  /** Has the Room open right now (live presence). Undefined when unknown, e.g. the scripted fixture. */
  online?: boolean;
}

/** One person's agent, running on their own machine, working in the open. */
export interface RoomAgent {
  agent: AgentKind;
  owner: PersonId;
  model: string;
  busy: boolean;
}

export type LogoId = 'claude' | 'openai' | 'metabase' | 'mixpanel' | 'gads' | 'rig';

export interface RoomConnector {
  id: string;
  name: string;
  /** Brand mark for connectors predating the BYOA catalog (Metabase, Mixpanel in the scripted demo). Catalog connectors (see connectors-spec.md) render a brand-colored tile from `@shared/spaces/connectors` instead — see `ConnectorMark`. */
  logo?: LogoId;
  addedBy: PersonId;
  /** Your own connection to this connector on this machine (connectors-spec.md's "connection"), from the local connectors RPC. Undefined for the scripted demo's pre-BYOA connectors, which have no such concept. */
  mine?: ConnectionState;
  /** Who you're signed in as there, when the connector's server says (`ConnectionStatus.account`). Local to you; undefined when unknown. */
  account?: string;
}

export interface RoomSkill {
  /** Slash-command form, e.g. "/launch-review". */
  cmd: string;
  name: string;
  desc: string;
  addedBy: PersonId;
}

// ────────── session projection (ported from the spike's session-log/lib.ts) ──────────

export interface SessionStep {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  locations?: Array<{ path: string; line?: number | null }>;
  /** A rig tool's arguments (who, which file), so the step reads "Rig · invite hugo@…". */
  args?: RigToolArgs;
  /** Only its label reached the room: a connector's result, or a file outside the space ("Room sees" at Steps). */
  private?: boolean;
}

export interface SessionOutput {
  path: string;
  adds: number;
  dels: number;
  /** true when a real diff couldn't be computed (oldText missing/huge, or the fixture truncated the text) — the count is a length-delta only. */
  approximate: boolean;
}

export interface SessionPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface SessionPermissionPending {
  requestId: string;
  toolCallId: string;
  title: string;
  options: SessionPermissionOption[];
  requestedAt: number;
}

export interface SessionPermissionDecided {
  requestId: string;
  toolCallId: string;
  optionId: string;
  outcome: string;
  /** The chosen option's ACP kind (`allow_once`, `allow_always`, `reject_once`, …), when the request was seen. */
  optionKind?: string;
  /** What was asked, from the request. */
  title?: string;
  /** When it was answered (ms), when the event says. */
  decidedAt?: number;
}

export type SessionStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'failed';

/** One entry of the plan an agent publishes (ACP `plan`): what it means to do, and how far along it is. */
export interface SessionPlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** The pure projection of a run's event log — what the session card renders. */
export interface SessionCard {
  status: SessionStatus;
  /** The model the agent ran, once it reports one. */
  model: string | null;
  /** Why the run failed, when it says. */
  failureReason: string | null;
  currentStep: { toolCallId: string; title?: string; kind?: string; args?: RigToolArgs } | null;
  outputs: SessionOutput[];
  steps: SessionStep[];
  finalAnswer: string;
  /** The agent's latest plan, replaced whole on every update; empty when it never published one. */
  plan: SessionPlanEntry[];
  /** The agent's visible reasoning, accumulated across the turn. */
  thinking: string;
  /** How full the agent's context window was at its last report (tokens), and what the turn cost, when it says. */
  usage: { used: number; size: number; costUsd: number | null } | null;
  permissions: {
    pending: SessionPermissionPending[];
    decided: SessionPermissionDecided[];
  };
  lastSeq: number;
  /** Connectors this run's agent couldn't reach (missing/expired), from a `run_connectors` event — connectors-spec.md's Nudge. Empty when the run recorded none. */
  connectorGaps: ConnectorGap[];
  /** The "Room sees" level the run ran at (`run_privacy`); null for a run from before the setting. */
  privacy: RoomSees | null;
  /** Steps the room was only told the number of (`private_progress`, or `details_hidden`). */
  privateSteps: number;
  /** Its owner hid its details after the fact: the room now sees only the answer. */
  detailsHidden: boolean;
  /** The emojis the run reacted with when it ended without words (`turn_ended.reacted`); empty otherwise. */
  reacted: string[];
  /** Its first try failed on the agent's sign-in and the prompt went again in this run (`run_retried`). */
  retriedAfterSignIn: boolean;
}

/**
 * One wire event in a run's event log. Field names/shape mirror the relay
 * contract sketched in the spike (`tap-spike-sessions/packages/relay/
 * spikes/session-log/lib.ts`'s `WireEvent`) — `truncated`/`originalBytes`
 * are this app's own addition (see fixtures/README below) for payloads a
 * fixture had to shrink; the real relay may instead just cap payload size
 * server-side and never send them. `originalBytes` corresponds to what the
 * lane-2 build doc calls `original_bytes` in the wire shape — camelCased
 * here to match this codebase's convention; flagged as an open question in
 * NOTES.md for lane 3 to confirm against the real relay.
 */
export interface SessionEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  originalBytes?: number;
}

export interface SessionRunMeta {
  id: string;
  agent: AgentKind;
  owner: PersonId;
  model: string;
  title: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
}

// ────────── room messages ──────────

export type MessageMeta =
  | {
      kind: 'text';
      /** A quote-reply: the message this one answers, with a short excerpt to show above it. */
      replyTo?: RoomReplyRef;
      /** Files sent with the message (board 19), shown as cards. */
      attachments?: MessageAttachment[];
      /** The body was written for older apps because only files were sent; cards say it already. */
      autoBody?: boolean;
      /** A thread reply sent with "Also send to #space": Threads view shows it in the main column too. */
      alsoInChannel?: boolean;
      /** The people tagged by picking them in the composer, in order: their id and the name as written (`meta.mentions` + `meta.mentionNames`). */
      mentions?: MessageMention[];
      /** The sender's own agent this message asked (`meta.asks`): the Room shows it as waiting until a run starts on it. */
      asks?: AgentKind;
    }
  | {
      kind: 'session';
      runId: string;
      /** The message that asked for this run, when the session message says (Threads view puts the run in that message's thread). */
      sourceMessageId?: string;
    }
  | { kind: 'invite'; inviteId: string }
  | {
      kind: 'comment_mirror';
      commentId: string;
      path: string;
      quote: string;
      /** Present on the second message of a thread — the agent's reply, not the human's original comment. Its owner is `RoomMessage.authorId`. */
      replyFromAgent?: AgentKind;
      /** A reply in the comment thread rather than the thread's first comment. */
      isReply?: boolean;
      /** A pin on a web page: the page's title when it was pinned (the path is its link). */
      pageTitle?: string;
      /** The thread's number, as its pin shows it (saved on its first comment when it was made). */
      pin?: number;
    }
  | { kind: 'system'; event: string; /** Set on `connectors_added`/`connectors_removed` — see connectors-spec.md. */ connectorIds?: string[] };

/** A person tagged in a message: who (their member id) and the name the text carries after its "@". */
export interface MessageMention {
  id: PersonId;
  name: string;
}

/** What a quote-reply points at. The author is a member id; for an agent's answer, its owner. */
export interface RoomReplyRef {
  id: string;
  authorId: string;
  /** Who it's from as a label ("Sam", "Sam's Claude"). */
  label: string;
  excerpt: string;
}

export type MessageKind = MessageMeta['kind'];

export interface RoomMessage {
  id: string;
  seq: number;
  authorId: PersonId;
  createdAt: string;
  /** Rendered time label as the demo shows it (e.g. "14:02") — precomputed so components don't reformat timestamps per-locale. */
  time: string;
  /** Chat text (for 'text' messages) — raw-ish markup: @mentions, /commands, +file.md, bare paths get inline emphasis, same as the demo's `rich()`. */
  body?: string;
  meta: MessageMeta;
  /** The doc comment thread this belongs to (its first comment's id): the comment itself, its replies, and agent runs answering it. */
  threadId?: string;
  /** Your own message, shown the moment you send it, before the relay has it back. */
  sending?: true;
  /** The id the sending app gave it (`meta.clientId`): its sending copy and the relay's are the same message. */
  clientId?: string;
  /** Emoji reactions, as chips under it; reactor ids are member ids. Absent or empty when none. */
  reactions?: MessageReaction[];
  /** The relay's own name and photo for the author, so someone no longer in the roster still has a name. */
  authorName?: string | null;
  authorAvatarUrl?: string | null;
}

export interface RoomInvite {
  id: string;
  by: PersonId;
  /** A member id (scripted demo) or, for a live invite, the invitee's email ('' for an open link). */
  who: PersonId;
  status: 'sent' | 'joined';
  /** Live invites only: the invited email (null for an open link) and role. */
  email?: string | null;
  role?: string;
  /** An invite aimed at one person: their user id, name and photo (the composer offers them as "Invited"). */
  target?: { userId: string; name: string | null; avatarUrl: string | null };
  /** Revoked by the owner: kept for its card, never offered as someone to tag. */
  revoked?: true;
}

// ────────── room events (the append-only feed a RoomSource replays) ──────────

export type RoomEvent =
  /**
   * The minimal contract fields are `id`/`seq`/`kind` — a room source that
   * only has those (a real relay one, where the message body lives in a
   * separate table) would need a follow-up fetch by `id`. `FixtureRoomSource`
   * has no separate store to fetch from, so this fixture-local shape inlines
   * the full `message` too; see `NOTES.md` for what lane 3's relay-backed
   * source should do instead (likely resolve `message` itself before
   * notifying, so the Room UI never has to know the difference).
   */
  | { type: 'message_created'; id: string; seq: number; kind: MessageKind; message: RoomMessage }
  /** Scrollback: a page before the oldest message is on its way, or landed (prepended in seq order). */
  | { type: 'older_messages_loading' }
  | { type: 'older_messages_loaded'; messages: RoomMessage[]; more: boolean }
  | { type: 'session_event_appended'; runId: string; seq: number; event: SessionEvent }
  | { type: 'agent_request_created'; id: string; targetOwner: PersonId; agent: AgentKind }
  /** Adds the member (status 'invited') and creates its `RoomInvite` in one step — `who` must be a known room member (see the fixture's `PEOPLE` map). */
  | { type: 'member_invited'; who: PersonId; by: PersonId; inviteId: string }
  | { type: 'member_joined'; id: PersonId }
  /** The roster, re-read from the relay (the live source's fallback poll). */
  | { type: 'members_synced'; members: RoomMember[] }
  | { type: 'invite_status_changed'; inviteId: string; status: RoomInvite['status'] }
  | { type: 'connector_added'; connector: RoomConnector }
  /** The space's full connector list, refetched from the relay (+ local connection state) — see `RelayRoomSource.refreshConnectors`. */
  | { type: 'connectors_synced'; connectors: RoomConnector[] }
  | { type: 'skill_added'; skill: RoomSkill }
  | { type: 'agent_busy_changed'; agent: AgentKind; owner: PersonId; busy: boolean }
  | { type: 'session_started'; runId: string; meta: SessionRunMeta }
  /** A run's header and its whole log at once (`session_started` plus every event, in one step) — how a fetched log lands. */
  | { type: 'session_log_loaded'; runId: string; meta: SessionRunMeta; events: SessionEvent[] }
  /** A run's header, re-read once it finished (its end time; a run's status change is never broadcast). */
  | { type: 'session_meta_updated'; runId: string; meta: Pick<SessionRunMeta, 'status' | 'endedAt'> }
  | { type: 'typing_started'; personId: PersonId }
  | { type: 'typing_stopped'; personId: PersonId }
  /** Who has the Room open right now; everyone else is away. */
  | { type: 'presence_changed'; onlineIds: PersonId[] }
  | { type: 'connection_changed'; connection: RoomConnection }
  | { type: 'space_ready_changed'; ready: boolean }
  /** The Room's first read of the relay's messages came back (see `RoomSnapshot.loaded`). */
  | { type: 'room_loaded' }
  /** The space was renamed. */
  | { type: 'room_renamed'; name: string }
  /** A Room shown from disk has caught up with the relay (see `RoomSnapshot.stale`). */
  | { type: 'room_caught_up' }
  /** The relay's last answer failed, or answered again (see `RoomSnapshot.relayUnreachable`). */
  | { type: 'relay_reachability_changed'; unreachable: boolean }
  /** These messages' reactions, whole (an empty list clears them); messages not named keep theirs. */
  | { type: 'reactions_changed'; reactions: Record<string, MessageReaction[]> }
  /** Room themes: the relay's snapshot, whole (`RoomSnapshot.themes` becomes it). */
  | { type: 'themes_synced'; snapshot: ThemesSnapshotWire }
  /** Room themes: a batch of the relay's events after `themes.cursor`; `upTo` is the batch's last event id as sent. Ignored while there are no themes. */
  | { type: 'themes_applied'; events: ThemeEvent[]; upTo: string | null }
  /** Room themes: the relay has none for this Room (unsupported, or the flag went off). */
  | { type: 'themes_cleared' };

/** Full materialized state of a room — what components render from. */
export interface RoomSnapshot {
  name: string;
  /** True only for a brand-new, empty space (the "invite people" empty state) — not part of the required component set, kept for FixtureRoomSource fidelity to the demo's story. */
  ready: boolean;
  members: RoomMember[];
  agents: RoomAgent[];
  connectors: RoomConnector[];
  skills: RoomSkill[];
  messages: RoomMessage[];
  invitesById: Record<string, RoomInvite>;
  sessionMetaByRun: Record<string, SessionRunMeta>;
  sessionEventsByRun: Record<string, SessionEvent[]>;
  typingUserIds: PersonId[];
  /** The live link to the relay; absent for the scripted demo. */
  connection?: RoomConnection;
  /** False until the live Room's first read of the relay's messages is in (the opening skeleton shows until then); absent for the scripted demo. */
  loaded?: boolean;
  /** Runs a message names whose log is still loading: their cards show as placeholders until it lands. */
  runsLoading?: Record<string, true>;
  /**
   * Scrollback: whether there are messages before the oldest one here.
   * 'more' (scrolling up loads a page), 'loading', or 'none' (the start of
   * the space). Absent for a source with no scrollback (the scripted demo).
   */
  olderMessages?: 'more' | 'loading' | 'none';
  /**
   * Finished runs shown from the disk cache: only what survives "Hide
   * details" (answer, status, step count…), until their log is fetched
   * (the card expanded). See `runCard` in `projection.ts`.
   */
  sessionSummaryByRun?: Record<string, RunSummary>;
  /** Shown from the disk cache and not caught up with the relay yet ("Catching up…"; the "New" line waits). */
  stale?: boolean;
  /**
   * The relay's last read failed (down, timed out, no network) — distinct
   * from `connection: 'offline'`, which only means the socket is down while
   * polling may still be getting through. Cleared by the next answer.
   */
  relayUnreachable?: boolean;
  /**
   * Room themes (themes.ts): absent or null while unknown, unsupported by the
   * relay, or the `roomThemesEnabled` flag is off; else the relay's themes
   * for this Room. Not kept on the disk cache: always fetched fresh.
   */
  themes?: RoomThemes | null;
}

/** Whether the Room is hearing the relay live: first connecting, connected, or without the socket (it retries on its own, and polls meanwhile). */
export type RoomConnection = 'connecting' | 'online' | 'offline';
