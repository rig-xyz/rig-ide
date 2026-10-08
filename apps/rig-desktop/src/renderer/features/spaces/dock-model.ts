/**
 * Room themes (rig/docs/room-themes-spec.md §7): what the dock shows, as
 * pure functions of the Room's snapshot, so each rule is testable on its own.
 * The components (`components/theme-dock.tsx` and its parts) only draw it.
 */

import type { DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import { formatElapsed } from '@renderer/lib/time-format';
import type { TranscriptFocus } from './components/room-transcript';
import type { ForYou } from './for-you';
import { effectiveRunStatus, projectSessionCard, runCard } from './projection';
import type { RoomTheme, RoomThemes } from './themes';
import { personOf } from './person-identity';
import type { AgentKind, RoomMember, RoomSnapshot } from './types';

/** What the transcript is focused on, if anything. */
export type DockFocus = { kind: 'theme'; themeId: string } | { kind: 'for-you' };

export const MAX_VISIBLE_THEMES = 6;
/** A theme with no new message in the Room's last this many leaves the visible pills, but stays in "+N". */
export const ACTIVE_WINDOW_MESSAGES = 60;
export const MAX_RAIL_MEMBERS = 6;
export const MAX_RAIL_AGENTS = 3;

const THEME_SLOTS = 8;
const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };

/** A theme's dot: one of the `--theme-N` tokens, the same slot for the same id every time. */
export function themeColor(themeId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < themeId.length; i++) {
    hash ^= themeId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `var(--theme-${(hash % THEME_SLOTS) + 1})`;
}

export function sameFocus(a: DockFocus | null, b: DockFocus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind && (a.kind === 'for-you' || (b.kind === 'theme' && a.themeId === b.themeId))
  );
}

/** Themes with something in them, most recently active first. */
export function activeThemes(themes: readonly RoomTheme[]): RoomTheme[] {
  return themes
    .filter((t) => t.count > 0)
    .sort((a, b) => b.lastSeq - a.lastSeq || a.id.localeCompare(b.id));
}

/**
 * The pills: themes with something in them, most recently active first. The
 * first six that are still active are shown; the rest wait behind "+N". A
 * focused theme that would be behind "+N" is brought to the front, so the
 * card the reader opened is always visible.
 */
export function splitThemes(
  themes: readonly RoomTheme[],
  messages: readonly { seq: number }[],
  focusedId: string | null = null
): { shown: RoomTheme[]; rest: RoomTheme[] } {
  const sorted = activeThemes(themes);
  let floor = Number.NEGATIVE_INFINITY;
  if (messages.length > ACTIVE_WINDOW_MESSAGES) {
    const seqs = messages.map((m) => m.seq).sort((a, b) => b - a);
    floor = seqs[ACTIVE_WINDOW_MESSAGES - 1]!;
  }
  let shown = sorted.filter((t) => t.lastSeq >= floor).slice(0, MAX_VISIBLE_THEMES);
  const focused = focusedId ? sorted.find((t) => t.id === focusedId) : undefined;
  if (focused && !shown.includes(focused)) {
    shown = [focused, ...shown].slice(0, MAX_VISIBLE_THEMES);
    shown.sort((a, b) => b.lastSeq - a.lastSeq || a.id.localeCompare(b.id));
  }
  return { shown, rest: sorted.filter((t) => !shown.includes(t)) };
}

export function forYouCount(forYou: Pick<ForYou, 'asks' | 'approvals'>): number {
  return forYou.asks.length + forYou.approvals.length;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** "Maya asked you directly. Your Claude has 3 approvals waiting in 2 runs." */
export function forYouLine(forYou: Pick<ForYou, 'asks' | 'approvals'>): string {
  const parts: string[] = [];
  const names = [...new Set(forYou.asks.map((a) => a.actor.name?.trim() || 'Someone'))];
  if (names.length > 0) parts.push(`${joinNames(names)} asked you directly.`);
  if (forYou.approvals.length > 0) {
    const total = forYou.approvals.reduce((n, a) => n + a.pending.length, 0);
    const kinds = [...new Set(forYou.approvals.map((a) => a.agent))];
    const who = kinds.length === 1 ? `Your ${AGENT_LABEL[kinds[0]!]}` : 'Your agents';
    const runs = forYou.approvals.length > 1 ? ` in ${forYou.approvals.length} runs` : '';
    parts.push(
      `${who} ${kinds.length === 1 ? 'has' : 'have'} ${total} ${total === 1 ? 'approval' : 'approvals'} waiting${runs}.`
    );
  }
  return parts.length > 0 ? parts.join(' ') : 'Nothing is waiting on you.';
}

export type RailMember = {
  member: RoomMember;
  /** Has the Room open: full strength. Absent is greyed. */
  present: boolean;
  typing: boolean;
};

/**
 * Everyone in the Space (not the people only invited), the six first in this
 * order: typing, then present, then away; by name within each group, so the
 * order only changes when someone's state does. `more` is how many are left.
 */
export function railMembers(
  snapshot: Pick<RoomSnapshot, 'members' | 'typingUserIds'>,
  selfUserId: string
): { shown: RailMember[]; more: number } {
  const everyone = snapshot.members
    .filter((m) => m.status !== 'invited')
    .map((member): RailMember => {
      const typing = snapshot.typingUserIds.includes(member.id);
      return { member, typing, present: typing || member.id === selfUserId || member.online !== false };
    });
  const rank = (m: RailMember) => (m.typing ? 0 : m.present ? 1 : 2);
  everyone.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.member.name.localeCompare(b.member.name) ||
      a.member.id.localeCompare(b.member.id)
  );
  return {
    shown: everyone.slice(0, MAX_RAIL_MEMBERS),
    more: Math.max(0, everyone.length - MAX_RAIL_MEMBERS),
  };
}

export type RailAgent = {
  agent: AgentKind;
  owner: string;
  own: boolean;
  /** Start time of the agent's latest run in this Space, ms. */
  lastRunAt: number;
  /** A turn is running (working, or waiting on an approval): full strength. Idle is greyed. */
  active: boolean;
};

/**
 * Every agent that has run in this Space, the first three on the rail:
 * running ones first, then idle ones; yours before others' and the newest
 * run first within each group, so the order only changes when a state does.
 */
export function railAgents(
  snapshot: Pick<RoomSnapshot, 'sessionMetaByRun' | 'sessionEventsByRun'>,
  selfUserId: string
): { shown: RailAgent[]; more: number } {
  const latest = new Map<string, RailAgent>();
  for (const meta of Object.values(snapshot.sessionMetaByRun)) {
    const at = Date.parse(meta.startedAt) || 0;
    const key = `${meta.owner}:${meta.agent}`;
    const seen = latest.get(key);
    if (!seen || at > seen.lastRunAt) {
      const card = projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? []);
      latest.set(key, {
        agent: meta.agent,
        owner: meta.owner,
        own: meta.owner === selfUserId,
        lastRunAt: at,
        active: effectiveRunStatus(meta.status, card) === 'running',
      });
    }
  }
  const all = [...latest.values()].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.own) - Number(a.own) ||
      b.lastRunAt - a.lastRunAt ||
      a.owner.localeCompare(b.owner) ||
      a.agent.localeCompare(b.agent)
  );
  return {
    shown: all.slice(0, MAX_RAIL_AGENTS),
    more: Math.max(0, all.length - MAX_RAIL_AGENTS),
  };
}

export function agentDisplayName(agent: AgentKind, ownerName: string | null): string {
  return ownerName ? `${ownerName}'s ${AGENT_LABEL[agent]}` : `Your ${AGENT_LABEL[agent]}`;
}

/** Pending requests of your agent of this kind, for the badge. */
export function pendingFor(forYou: Pick<ForYou, 'approvals'>, agent: AgentKind): number {
  return forYou.approvals
    .filter((a) => a.agent === agent)
    .reduce((n, a) => n + a.pending.length, 0);
}

export function themeOfMessage(
  themes: RoomThemes | null | undefined,
  messageId: string | null
): RoomTheme | undefined {
  if (!themes || !messageId) return undefined;
  const id = themes.themeOf[messageId]?.themeId;
  return id ? themes.list.find((t) => t.id === id) : undefined;
}

/** Who spoke last in a theme and when, for the pill's peek. */
export function themeLastActivity(
  themeId: string,
  themes: RoomThemes,
  snapshot: Pick<RoomSnapshot, 'messages' | 'members' | 'sessionMetaByRun'>,
  selfUserId: string
): { who: string; time: string } | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const message = snapshot.messages[i]!;
    if (themes.themeOf[message.id]?.themeId !== themeId) continue;
    const ownerName = message.authorId === selfUserId ? null : personOf(snapshot, message.authorId).name;
    const run =
      message.meta.kind === 'session' ? snapshot.sessionMetaByRun[message.meta.runId] : undefined;
    const who = run ? agentDisplayName(run.agent, ownerName) : (ownerName ?? 'you');
    return { who, time: message.time };
  }
  return null;
}

// ────────── spotlight: a person or an agent ──────────

/** A face in the dock the transcript can be filtered to: a person, or one person's agent of one kind. */
export type DockWho =
  | { kind: 'person'; userId: string }
  | { kind: 'agent'; owner: string; agent: AgentKind };

export function sameWho(a: DockWho | null, b: DockWho | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'person') return b.kind === 'person' && a.userId === b.userId;
  return b.kind === 'agent' && a.owner === b.owner && a.agent === b.agent;
}

/** A stable key for a face, for focus keys and React keys. */
export function whoKey(who: DockWho): string {
  return who.kind === 'person' ? `person:${who.userId}` : `agent:${who.owner}:${who.agent}`;
}

/**
 * The messages that belong to a face. A person: everything they wrote, and
 * every run of their agents (those messages carry the owner as their author).
 * An agent: its runs, its replies in doc threads, and the messages that asked
 * for its runs.
 */
export function whoMessageIds(
  snapshot: Pick<RoomSnapshot, 'messages' | 'sessionMetaByRun'>,
  who: DockWho
): Set<string> {
  const ids = new Set<string>();
  for (const message of snapshot.messages) {
    if (who.kind === 'person') {
      const run =
        message.meta.kind === 'session' ? snapshot.sessionMetaByRun[message.meta.runId] : undefined;
      if (message.authorId === who.userId || run?.owner === who.userId) ids.add(message.id);
      continue;
    }
    if (message.meta.kind === 'session') {
      const run = snapshot.sessionMetaByRun[message.meta.runId];
      if (run && run.owner === who.owner && run.agent === who.agent) {
        ids.add(message.id);
        if (message.meta.sourceMessageId) ids.add(message.meta.sourceMessageId);
      }
    } else if (
      message.meta.kind === 'comment_mirror' &&
      message.meta.replyFromAgent === who.agent &&
      message.authorId === who.owner
    ) {
      ids.add(message.id);
    }
  }
  return ids;
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of a) if (b.has(id)) out.add(id);
  return out;
}

const pluralMessages = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

/**
 * A topic's (or For you's) focus with the spotlit face on top: the transcript
 * keeps what is in both, and the fold rows say why the rest is folded. No
 * face: the topic's focus as it is. A face alone: its messages.
 */
export function spotlightFocus(
  topic: TranscriptFocus | undefined,
  spotlight: { who: DockWho; messageIds: ReadonlySet<string> } | null,
  forYou: boolean
): TranscriptFocus | undefined {
  if (!spotlight) return topic;
  const key = whoKey(spotlight.who);
  if (!topic) {
    return {
      messageIds: spotlight.messageIds,
      key,
      foldLabel: (n) => `${pluralMessages(n)} from others`,
    };
  }
  const rest = forYou ? 'not waiting on you' : 'in other topics';
  return {
    ...topic,
    messageIds: intersect(topic.messageIds, spotlight.messageIds),
    ...(topic.askIds ? { askIds: intersect(topic.askIds, spotlight.messageIds) } : {}),
    key: `${topic.key ?? ''}|${key}`,
    foldLabel: (n) => `${pluralMessages(n)} from others or ${rest}`,
  };
}

/** What the chip calls a face: "You", "Sam", "Your Claude", "Sam's Codex". */
export function whoName(
  snapshot: Pick<RoomSnapshot, 'members' | 'messages'>,
  who: DockWho,
  selfUserId: string
): string {
  if (who.kind === 'person') {
    return who.userId === selfUserId ? 'You' : personOf(snapshot, who.userId).name;
  }
  return agentDisplayName(
    who.agent,
    who.owner === selfUserId ? null : personOf(snapshot, who.owner).name
  );
}

// ────────── tasks in progress ──────────

/** A finished run stays in the dock this long, as "Done". */
export const JUST_FINISHED_MS = 5 * 60 * 1000;

const STEP_MATRIX: Record<string, DotMatrixState> = {
  read: 'reading',
  fetch: 'reading',
  edit: 'editing',
  delete: 'editing',
  move: 'editing',
  search: 'searching',
  execute: 'running',
  think: 'thinking',
};

export type DockTask = {
  runId: string;
  /** The run's own message in the transcript, to jump to. */
  messageId: string;
  agent: AgentKind;
  owner: string;
  own: boolean;
  title: string;
  state: 'working' | 'waiting' | 'done';
  /** The run's dot matrix: its live motion, or its end glyph. */
  matrix: DotMatrixState;
  /** What it is doing now, in words, for the peek. */
  step: string;
  /** The row's time: how long it has run, who it waits on, or that it is done. */
  status: string;
  /** Its topic, once the relay has placed the run or its ask; null until then. */
  themeId: string | null;
};

/**
 * The agent runs to show in the dock: working, waiting on an approval, or
 * finished in the last few minutes, oldest first. Each sits under its topic;
 * the relay holds an agent ask until its run ends (room-themes-spec.md §3.3),
 * so a running task usually has none yet.
 */
export function dockTasks(
  snapshot: Pick<
    RoomSnapshot,
    'messages' | 'members' | 'sessionMetaByRun' | 'sessionEventsByRun' | 'sessionSummaryByRun'
  >,
  themes: RoomThemes | null | undefined,
  selfUserId: string,
  now: number
): DockTask[] {
  const tasks: Array<DockTask & { at: number }> = [];
  for (const message of snapshot.messages) {
    if (message.meta.kind !== 'session') continue;
    const meta = snapshot.sessionMetaByRun[message.meta.runId];
    if (!meta) continue;
    const card = runCard(snapshot, meta.id);
    const status = effectiveRunStatus(meta.status, card);
    const own = meta.owner === selfUserId;
    const ownerName = own ? null : personOf(snapshot, meta.owner).name;
    const startedAt = Date.parse(meta.startedAt) || now;
    let state: DockTask['state'];
    let matrix: DotMatrixState;
    let step: string;
    let label: string;
    if (status === 'running' || status === 'waiting') {
      const pending = card.permissions.pending.length > 0;
      const hidden = !own && (card.privacy === 'answer' || card.detailsHidden);
      state = pending ? 'waiting' : 'working';
      matrix = pending
        ? 'waiting'
        : card.currentStep
          ? (STEP_MATRIX[card.currentStep.kind ?? ''] ?? 'thinking')
          : 'thinking';
      const waitingOn = ownerName ? `Waiting on ${ownerName}` : 'Waiting on you';
      step = pending
        ? waitingOn
        : hidden
          ? 'Working'
          : (card.currentStep?.title ?? 'Thinking');
      label = pending ? waitingOn : formatElapsed(now - startedAt);
    } else {
      const endedAt = meta.endedAt ? Date.parse(meta.endedAt) : NaN;
      if (Number.isNaN(endedAt) || now - endedAt > JUST_FINISHED_MS) continue;
      state = 'done';
      matrix = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'done';
      label = status === 'failed' ? 'Failed' : status === 'stopped' ? 'Stopped' : 'Done';
      step = label;
    }
    const themeId =
      themes?.themeOf[message.id]?.themeId ??
      (message.meta.sourceMessageId ? themes?.themeOf[message.meta.sourceMessageId]?.themeId : undefined) ??
      null;
    tasks.push({
      runId: meta.id,
      messageId: message.id,
      agent: meta.agent,
      owner: meta.owner,
      own,
      title: meta.title.trim() || agentDisplayName(meta.agent, ownerName),
      state,
      matrix,
      step,
      status: label,
      themeId: themeId && themes?.list.some((t) => t.id === themeId) ? themeId : null,
      at: startedAt,
    });
  }
  tasks.sort((a, b) => a.at - b.at || a.runId.localeCompare(b.runId));
  return tasks.map(({ at: _at, ...task }) => task);
}
