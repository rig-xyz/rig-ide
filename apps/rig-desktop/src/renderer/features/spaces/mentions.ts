import type { MessageMention } from './types';

/**
 * Tagging people by their full name (rig/docs/people-management-scope.md):
 * what the composer's `@` is matching, who it offers, and which tags are
 * still in the text when it's sent.
 *
 * The query runs from an `@` at the start or after a space to the cursor,
 * any letters (accents too) and up to four words, so "@Jérémie Ra" keeps
 * matching. A name matches when the query's words start consecutive words
 * of it, ignoring case and accents: "ra", "jér" and "jeremie rap" all find
 * "Jérémie Rappaz".
 */

/** The `@query` being typed at the end of the draft. */
const MENTION_QUERY = /(?:^|\s)@((?:[\p{L}\p{M}\p{N}'’._-]+ ?){0,4})$/u;

/** Lowercase, without accents: "Jérémie" → "jeremie". */
export function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function words(value: string): string[] {
  return foldName(value)
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Whether `name` is a match for the typed `query` (an empty query matches everyone). */
export function nameMatches(name: string, query: string): boolean {
  const q = words(query);
  if (q.length === 0) return true;
  const w = words(name);
  for (let i = 0; i + q.length <= w.length; i++) {
    if (q.every((part, k) => w[i + k]!.startsWith(part))) return true;
  }
  return false;
}

/**
 * The query after the last `@`, or null when there's none. A query that ends
 * in a space after a whole name ("@Hugo Renaudin ") is a finished tag, not
 * one being typed: the menu stays closed, so Enter sends.
 */
export function mentionQueryOf(value: string, names: readonly string[]): string | null {
  const query = MENTION_QUERY.exec(value)?.[1];
  if (query === undefined || query.startsWith(' ')) return null;
  if (query.endsWith(' ')) {
    const typed = foldName(query.trim());
    if (names.some((name) => foldName(name.trim()) === typed)) return null;
  }
  return query;
}

/** The draft with the `@query` at its end replaced by `@label `. */
export function applyMentionText(value: string, label: string): string {
  return value.replace(MENTION_QUERY, (m) => `${/^\s/.test(m) ? m[0] : ''}@${label} `);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The picked tags still written in `text`, in the order they appear, once
 * each: a tag the person deleted (or edited into another word) is dropped.
 */
export function presentMentions(text: string, picks: readonly MessageMention[]): MessageMention[] {
  const found: Array<{ at: number; mention: MessageMention }> = [];
  const seen = new Set<string>();
  for (const pick of picks) {
    if (seen.has(pick.id) || !pick.name.trim()) continue;
    const at = text.search(
      new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRegExp(pick.name)}(?![\\p{L}\\p{N}_])`, 'iu')
    );
    if (at === -1) continue;
    seen.add(pick.id);
    found.push({ at, mention: { id: pick.id, name: pick.name } });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.mention);
}

/** `meta.mentions` (ids) and `meta.mentionNames` (as written), back into pairs; a name missing for an id leaves it out. */
export function parseMessageMentions(ids: unknown, names: unknown): MessageMention[] {
  if (!Array.isArray(ids)) return [];
  const labels = Array.isArray(names) ? names : [];
  return ids.flatMap((id, i) => {
    const name = labels[i];
    return typeof id === 'string' && id && typeof name === 'string' && name.trim()
      ? [{ id, name }]
      : [];
  });
}

/** Someone the `@` menu can offer besides the space's members. */
export type MentionPerson = {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Invited to this space and not in yet, or one of your people who isn't in it. */
  group: 'invited' | 'outside';
  /** "2 spaces with you", for your people. */
  detail?: string;
};

/**
 * Who `@` offers besides the members: people with a pending invite aimed at
 * them, then your people who aren't in the space or invited, each once.
 * Nobody without a name (the relay puts the email there when none is set).
 */
export function mentionPeople(
  invites: ReadonlyArray<{
    status: 'sent' | 'joined';
    revoked?: true;
    target?: { userId: string; name: string | null; avatarUrl: string | null };
  }>,
  memberIds: ReadonlySet<string>,
  yourPeople: ReadonlyArray<{
    userId: string;
    name: string | null;
    avatarUrl: string | null;
    sharedSpaces: readonly unknown[];
  }>
): MentionPerson[] {
  const out: MentionPerson[] = [];
  const seen = new Set(memberIds);
  for (const invite of invites) {
    const target = invite.target;
    const name = target?.name?.trim();
    if (!target || !name || invite.revoked || invite.status !== 'sent' || seen.has(target.userId))
      continue;
    seen.add(target.userId);
    out.push({ id: target.userId, name, avatarUrl: target.avatarUrl, group: 'invited' });
  }
  for (const person of yourPeople) {
    const name = person.name?.trim();
    if (!name || seen.has(person.userId)) continue;
    seen.add(person.userId);
    const shared = person.sharedSpaces.length;
    out.push({
      id: person.userId,
      name,
      avatarUrl: person.avatarUrl,
      group: 'outside',
      ...(shared > 0 ? { detail: `${shared} ${shared === 1 ? 'space' : 'spaces'} with you` } : {}),
    });
  }
  return out;
}
