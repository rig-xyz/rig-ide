/**
 * Room themes (rig/docs/room-themes-spec.md §7): what the dock shows, as
 * pure functions of the Room's snapshot, so each rule is testable on its own.
 * The components (`components/theme-dock.tsx` and its parts) only draw it.
 */

import type { ForYou } from './for-you';
import { effectiveRunStatus, projectSessionCard } from './projection';
import type { RoomTheme, RoomThemes } from './themes';
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
    const owner = snapshot.members.find((m) => m.id === message.authorId);
    const ownerName = message.authorId === selfUserId ? null : (owner?.name ?? 'Someone');
    const run =
      message.meta.kind === 'session' ? snapshot.sessionMetaByRun[message.meta.runId] : undefined;
    const who = run ? agentDisplayName(run.agent, ownerName) : (ownerName ?? 'you');
    return { who, time: message.time };
  }
  return null;
}
