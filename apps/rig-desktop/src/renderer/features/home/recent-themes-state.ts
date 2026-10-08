import type { RigRecentTheme, RigRecentThemes } from '@shared/rig/recent-themes';

/**
 * Home's read of the relay's Room themes of the last 24h
 * (`@shared/rig/recent-themes`): the "Across your spaces today" lines and
 * each Spaces row's topic. Pure, so the choices are tested on their own.
 */

/** Lines shown before "N more topics". */
export const ACROSS_SHOWN_CAP = 5;
/** Names in a line's activity before "and N more". */
const PEOPLE_SHOWN_CAP = 3;

function newestFirst(a: RigRecentTheme, b: RigRecentTheme): number {
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  return b.lastSeq - a.lastSeq;
}

/** Newest first: the first `cap` lines, and the rest behind "N more topics". */
export function splitRecentThemes(
  themes: readonly RigRecentTheme[],
  cap = ACROSS_SHOWN_CAP
): { shown: RigRecentTheme[]; more: RigRecentTheme[] } {
  const sorted = [...themes].sort(newestFirst);
  return { shown: sorted.slice(0, cap), more: sorted.slice(cap) };
}

export function moreTopicsLabel(count: number): string {
  return `${count} more ${count === 1 ? 'topic' : 'topics'}`;
}

/** "5 new messages · Hugo, Hugo's Claude", or just the count when no one is named. */
export function themeActivityLine(theme: RigRecentTheme): string {
  const count = `${theme.messageCount} new ${theme.messageCount === 1 ? 'message' : 'messages'}`;
  if (theme.people.length === 0) return count;
  const named = theme.people.slice(0, PEOPLE_SHOWN_CAP).join(', ');
  const rest = theme.people.length - PEOPLE_SHOWN_CAP;
  return `${count} · ${rest > 0 ? `${named} and ${rest} more` : named}`;
}

/** A line's age, short: "now", "4m", "1h", "3d". Empty when `at` can't be read. */
export function shortAge(at: string, now: number): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The relay's agent labels (`actorLabel` in tap's `notify/copy.ts`): "Hugo's Claude". */
const AGENT_LABEL = /^(.+)'s (?:Claude|Codex|An agent)$/;

/**
 * The faces on a line: who wrote in the theme, an agent shown as its owner,
 * each person once, most recent first. "Hugo's Claude" and "Hugo" are one face.
 */
export function themeFaces(people: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of people) {
    const name = AGENT_LABEL.exec(label)?.[1] ?? label;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** How a full name is matched to the relay's first-name labels: its first word, any case. */
export function firstNameKey(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

/**
 * A picture for each first-name key, from everyone Home already knows: you,
 * your people, then Pulse's people. The first picture for a key wins, so a
 * first name two people share shows the one listed first.
 */
export function avatarsByFirstName(
  ...sources: ReadonlyArray<{ name: string | null; avatarUrl: string | null }>[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const people of sources) {
    for (const person of people) {
      const key = firstNameKey(person.name);
      if (key && person.avatarUrl && !out.has(key)) out.set(key, person.avatarUrl);
    }
  }
  return out;
}

/**
 * When each person last wrote in a Room today, by `firstNameKey`, their
 * agents included: the newest theme they're a face on. People are named by
 * first name only on the wire, so two teammates sharing one share a time.
 */
export function lastActivityByPerson(themes: readonly RigRecentTheme[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const theme of themes) {
    for (const face of themeFaces(theme.people)) {
      const key = firstNameKey(face);
      if (!key) continue;
      const current = out.get(key);
      if (!current || theme.lastActivityAt > current) out.set(key, theme.lastActivityAt);
    }
  }
  return out;
}

/**
 * Each space's most active theme of the window: the most messages, ties to
 * the most recent. One entry per space that has any.
 */
export function topicBySpace(themes: readonly RigRecentTheme[]): Map<string, RigRecentTheme> {
  const out = new Map<string, RigRecentTheme>();
  for (const theme of themes) {
    const current = out.get(theme.bindingId);
    if (
      !current ||
      theme.messageCount > current.messageCount ||
      (theme.messageCount === current.messageCount && newestFirst(theme, current) < 0)
    ) {
      out.set(theme.bindingId, theme);
    }
  }
  return out;
}

/** Where you've read a space up to: the relay's read cursor, and how many messages past it are someone else's. */
export type SpaceRead = { cursor: number; unread: number };

/** A topic past your read position, with how many of its messages are new to you; or one you've read. */
export type TopicMark = { kind: 'new'; count: number } | { kind: 'seen' };

/**
 * Marks each topic against its space's read cursor (the notifications
 * summary): new when its newest message is past the cursor and the space
 * has unread messages from someone else, with the topic's messages of the
 * day as its count, never more than the space's unread. Every other topic
 * of a space whose cursor is known is seen. A space with no known cursor
 * leaves its topics unmarked.
 */
export function markTopics(
  themes: readonly RigRecentTheme[],
  reads: ReadonlyMap<string, SpaceRead>
): Map<string, TopicMark> {
  const out = new Map<string, TopicMark>();
  for (const theme of themes) {
    const read = reads.get(theme.bindingId);
    if (!read) continue;
    out.set(
      theme.themeId,
      theme.lastSeq > read.cursor && read.unread > 0
        ? { kind: 'new', count: Math.max(1, Math.min(theme.messageCount, read.unread)) }
        : { kind: 'seen' }
    );
  }
  return out;
}

export type AcrossSpacesView =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'empty' }
  | { kind: 'themes'; themes: RigRecentTheme[] };

/**
 * What the section shows. The live answer wins; while it hasn't come (or the
 * relay can't be reached) the account's last one from this computer stands
 * in. With neither: a loading line, or, offline, a line saying when they'll
 * show.
 */
export function deriveAcrossSpacesView(input: {
  live: RigRecentThemes | undefined;
  cached: RigRecentThemes | undefined;
  offline: boolean;
}): AcrossSpacesView {
  const best = [input.live, input.cached].find(
    (r): r is Exclude<RigRecentThemes, { kind: 'none' }> => r !== undefined && r.kind !== 'none'
  );
  if (best)
    return best.themes.length > 0 ? { kind: 'themes', themes: best.themes } : { kind: 'empty' };
  if (input.offline || input.live?.kind === 'none') return { kind: 'offline' };
  return { kind: 'loading' };
}
