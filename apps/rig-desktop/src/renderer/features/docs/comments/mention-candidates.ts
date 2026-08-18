import type { AgentMention } from './comments-store';

/**
 * A person on the binding, for the `@mention` menu's People section.
 * Trimmed from `RigCommentMember` (`@shared/rig/comments`) to what the menu
 * and insertion actually need.
 */
export type PersonMention = {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
};

/**
 * One row of the unified `@mention` menu — an agent (dispatchable) or a
 * person (never dispatchable). Every place that needs to tell them apart
 * switches on `kind`, never on shape-sniffing a shared/overlapping type — the
 * one intentional coupling point for "agent vs person" in the whole feature.
 */
export type MentionCandidate =
  | { kind: 'agent'; agent: AgentMention }
  | { kind: 'person'; person: PersonMention };

const UNKNOWN_PERSON_LABEL = 'Unknown';

/** Display label for the menu row, and what the typed query matches against. */
export function mentionCandidateLabel(candidate: MentionCandidate): string {
  return candidate.kind === 'agent' ? candidate.agent.name : (candidate.person.name ?? UNKNOWN_PERSON_LABEL);
}

/** Stable id — agent provider id, or relay user id. Also matched against the query, not shown. */
export function mentionCandidateKey(candidate: MentionCandidate): string {
  return candidate.kind === 'agent' ? candidate.agent.providerId : candidate.person.userId;
}

/** True when `candidate` is a plausible match for the in-progress `@` query (case-insensitive). */
export function mentionCandidateMatches(candidate: MentionCandidate, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    mentionCandidateKey(candidate).toLowerCase().startsWith(needle) ||
    mentionCandidateLabel(candidate).toLowerCase().includes(needle)
  );
}

/**
 * The literal text inserted into the composer when the reader picks
 * `candidate` from the menu — the one place that decides what a mention
 * "looks like" once typed.
 *
 * An agent inserts `@providerId` — the exact token `findMention` (in
 * `comments-margin.tsx`) later scans reply/create bodies for to decide
 * whether to dispatch a headless turn. A person inserts `@Full Name`. A
 * person candidate has no `providerId` to draw from at all, so this can
 * never *produce* agent-dispatchable text for a person by construction —
 * not merely by the caller remembering to check `kind` before dispatching.
 *
 * (Known, accepted gap: if a person's name happens to equal a real agent's
 * provider id — someone literally named "Claude", say — `findMention` will
 * still key a dispatch off that text, the same as if the reader had typed
 * `@claude` by hand. `findMention` has no way to tell "this text happens to
 * spell an agent's id" from "the reader meant to summon that agent", for a
 * person mention or a plain typo alike. Narrow enough, and honest enough to
 * leave alone, for a v1.)
 */
export function mentionInsertText(candidate: MentionCandidate): string {
  if (candidate.kind === 'agent') return `@${candidate.agent.providerId} `;
  return `@${candidate.person.name ?? UNKNOWN_PERSON_LABEL} `;
}

// ── in-progress `@` query, and the dispatch decision ────────────────────────
//
// Both moved here (from `comments-margin.tsx`) alongside `MentionCandidate`
// so the one thing that actually matters for safety — a person mention can
// never key `findMention`'s dispatch decision — lives beside its own tests,
// not buried in the render file.

/** Matches an in-progress `@query` at the caret — the text after `@` so far. */
export const MENTION_TOKEN = /(?:^|\s)@([\w-]*)$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The agent a composed reply/comment body should dispatch to, if any —
 * i.e. what actually decides `askAgent` gets called.
 *
 * Deliberately keys on `agents` (the mentionable *agents* list) alone: it has
 * no idea `MentionCandidate`/`mentionInsertText` exist, and never will —
 * there is no "is this a person token" branch to get wrong, because a person
 * was never in scope here. See `mentionInsertText`'s doc comment for the one
 * narrow, accepted way a person's literal name can still coincide with an
 * agent's provider id.
 */
export function findMention(body: string, agents: AgentMention[]): AgentMention | undefined {
  return agents.find((agent) =>
    new RegExp(`(?:^|[^\\w-])@${escapeRegExp(agent.providerId)}(?![\\w-])`, 'i').test(body)
  );
}
