/**
 * Pure state for inviting people by name (people-management scope, v1 #2):
 * the invite field's chips, email validation, and which of Your people to
 * suggest as you type. No React, no relay: everything here is unit tested.
 */

import type { RigInviteRole, RigMember, RigPerson } from '@shared/rig/rig-share';

export type InviteChip =
  | { kind: 'person'; userId: string; name: string; avatarUrl: string | null }
  | { kind: 'email'; email: string };

export function chipKey(chip: InviteChip): string {
  return chip.kind === 'person' ? `person:${chip.userId}` : `email:${chip.email.toLowerCase()}`;
}

export function chipLabel(chip: InviteChip): string {
  return chip.kind === 'person' ? chip.name : chip.email;
}

/** Adds a chip unless the same person or address is already there. */
export function addChip(chips: InviteChip[], chip: InviteChip): InviteChip[] {
  const key = chipKey(chip);
  return chips.some((c) => chipKey(c) === key) ? chips : [...chips, chip];
}

/** Plain and permissive: one @, no spaces, a dot in the domain, a TLD of two letters or more. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(value.trim());
}

export const NOT_AN_EMAIL = 'Pick someone from the list, or type a full email address.';

/**
 * What Enter (or a comma) does with the typed text: a full email becomes an
 * email chip and clears the field; anything else stays, with a reason.
 * Empty text is a no-op.
 */
export function commitQuery(
  query: string,
  chips: InviteChip[]
): { chips: InviteChip[]; query: string; error: string | null } {
  const text = query.trim();
  if (!text) return { chips, query: '', error: null };
  if (!isValidEmail(text)) return { chips, query, error: NOT_AN_EMAIL };
  return { chips: addChip(chips, { kind: 'email', email: text }), query: '', error: null };
}

/**
 * Typing or pasting with separators ("a@x.io, b@y.io"): every finished
 * piece that is a full email becomes a chip; the unfinished last piece stays
 * in the field. A finished piece that isn't an email stays in the field too,
 * so nothing typed is ever silently dropped.
 */
export function splitTyped(
  value: string,
  chips: InviteChip[]
): { chips: InviteChip[]; query: string; error: string | null } {
  if (!/[,;\n]/.test(value)) return { chips, query: value, error: null };
  const parts = value.split(/[,;\n]+/);
  const last = parts.pop() ?? '';
  let next = chips;
  const leftover: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    if (isValidEmail(text)) next = addChip(next, { kind: 'email', email: text });
    else leftover.push(text);
  }
  const query = [...leftover, last.trimStart()].filter(Boolean).join(', ');
  return { chips: next, query, error: leftover.length > 0 ? NOT_AN_EMAIL : null };
}

/** Case and accent blind: "jer" finds Jérémie. */
export function foldName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export type PersonSuggestion = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  group: 'people' | 'org';
  /** The second line: how you know them. */
  why: string;
};

function sharedLine(person: RigPerson, nowMs: number): string {
  const n = person.sharedSpaces.length;
  if (n === 0) return person.viaOrg ? 'Your organization' : 'Worked with you before';
  const together = n === 1 ? '1 space together' : `${n} spaces together`;
  const at = person.lastSharedAt ? Date.parse(person.lastSharedAt) : Number.NaN;
  return Number.isNaN(at) ? together : `${together} · ${ageWord(at, nowMs)}`;
}

/** "today", "yesterday", "this week", "last week", "this month", "a while ago". */
export function ageWord(at: number, nowMs: number): string {
  const days = Math.floor((nowMs - at) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return 'this week';
  if (days < 14) return 'last week';
  if (days < 31) return 'this month';
  return 'a while ago';
}

/**
 * Who to suggest for `query`, from Your people: everyone already in the
 * space, already invited or already picked is left out; people you share
 * spaces with come before people known only through your organization; a
 * name that starts with the query (any word of it) comes before one that
 * merely contains it; otherwise the relay's own best-first order holds.
 */
export function rankPeople(
  people: RigPerson[],
  opts: { query: string; exclude: ReadonlySet<string>; nowMs: number; limit?: number }
): PersonSuggestion[] {
  const q = foldName(opts.query);
  const scored: { person: RigPerson; score: number; index: number }[] = [];
  people.forEach((person, index) => {
    if (opts.exclude.has(person.userId) || !person.name) return;
    const name = foldName(person.name);
    let match = 0;
    if (q) {
      if (name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q))) match = 0;
      else if (name.includes(q)) match = 1;
      else return;
    }
    const orgOnly = person.viaOrg && person.sharedSpaces.length === 0 ? 1 : 0;
    scored.push({ person, score: orgOnly * 2 + match, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, opts.limit ?? 6)
    .map(({ person }) => ({
      userId: person.userId,
      name: person.name ?? '',
      avatarUrl: person.avatarUrl,
      group: person.viaOrg && person.sharedSpaces.length === 0 ? 'org' : 'people',
      why: sharedLine(person, opts.nowMs),
    }));
}

/**
 * The older relay's suggestions (no `/v1/me/people`): members of your
 * other spaces who have an email on file, matched by name or email. A pick
 * becomes an email chip, since that relay can only aim an invite at an
 * address.
 */
export function rankCollaborators(
  collaborators: RigMember[],
  opts: {
    query: string;
    exclude: ReadonlySet<string>;
    excludeEmails: ReadonlySet<string>;
    limit?: number;
  }
): RigMember[] {
  const q = foldName(opts.query);
  return collaborators
    .filter((m) => m.email !== null && !opts.exclude.has(m.userId))
    .filter((m) => !opts.excludeEmails.has((m.email ?? '').toLowerCase()))
    .filter(
      (m) => !q || foldName(m.name ?? '').includes(q) || (m.email ?? '').toLowerCase().includes(q)
    )
    .slice(0, opts.limit ?? 6);
}

/** One `createInvite` per chip: a person by id, an email by address. */
export function inviteRequests(
  chips: InviteChip[],
  role: RigInviteRole
): { chip: InviteChip; email: string | null; targetUserId: string | null; role: RigInviteRole }[] {
  return chips.map((chip) =>
    chip.kind === 'person'
      ? { chip, email: null, targetUserId: chip.userId, role }
      : { chip, email: chip.email, targetUserId: null, role }
  );
}

export function sendLabel(count: number, sending: boolean): string {
  if (sending) return count > 1 ? `Sending ${count} invites…` : 'Sending…';
  return count > 1 ? `Send ${count} invites` : 'Send invite';
}

/** A member's display name. The relay puts the email into `name` when there's no name; "Someone" is the last resort. */
export function memberName(member: { name: string | null; email: string | null }): string {
  return member.name ?? member.email ?? 'Someone';
}
