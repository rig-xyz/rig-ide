import type { RigRecentTheme, RigRecentThemes } from '@shared/rig/recent-themes';

/**
 * Home's read of the relay's Room themes of the last 24h
 * (`@shared/rig/recent-themes`): the "Across your spaces today" cards and
 * each Spaces row's topic. Pure, so the choices are tested on their own.
 */

/** Cards shown before "N more topics". */
export const ACROSS_SHOWN_CAP = 5;
/** Names in a card's activity line before "and N more". */
const PEOPLE_SHOWN_CAP = 3;

function newestFirst(a: RigRecentTheme, b: RigRecentTheme): number {
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  return b.lastSeq - a.lastSeq;
}

/** Newest first: the first `cap` cards, and the rest behind "N more topics". */
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

/** A row's status line led by its topic: "Bugs & Wishlist · Hugo's Claude finished · 20m ago". */
export function withTopic(topic: string | null | undefined, statusLine: string): string {
  if (!topic) return statusLine;
  if (!statusLine || statusLine === 'No activity yet') return topic;
  return `${topic} · ${statusLine}`;
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
