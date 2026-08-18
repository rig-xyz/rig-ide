/**
 * Wraps `@mention`-shaped runs in markdown `**strong**` syntax before a
 * comment body reaches the markdown parser — picking up `CommentMarkdown`'s
 * existing `[&_strong]:font-semibold` treatment (weight only, no color: the
 * "subtle strong... neutral not accent" look both agent and person mentions
 * share, and the only visual distinction posted comments get for either).
 *
 * Purely syntactic — it matches the *shape* of a mention, not a verified
 * provider id or member list (this module has no way to reach either at
 * render time, and reaching for one would mean re-fetching agents/members
 * just to draw text). `@word` covers agent-style tokens (`@claude`); `@` plus
 * up to three Capitalized words covers person-style ones (`@Dylan
 * Bourgeois`). Runs on the string handed to the markdown parser only — the
 * stored comment body itself is never touched here, so it stays honest plain
 * text for every other client that reads it (CLI, web hub, …), exactly as
 * posted.
 *
 * Skips fenced code blocks and inline code spans, so a literal `@usage` in a
 * code sample is never mistaken for a mention. Best-effort, not a full
 * markdown parse — the same tradeoff `findMention` (comment dispatch) makes
 * for its own, much narrower, agent-id pattern.
 */

const CODE_SPAN_OR_FENCE = /(```[\s\S]*?```|`[^`\n]*`)/g;
// The Capitalized-words branch must come first: regex alternation takes the
// first branch that matches at all, not the longest, so `[\w-]+` alone would
// otherwise claim just "Dylan" out of "@Dylan Bourgeois" and never backtrack.
const MENTION_SHAPE = /(?<=^|[\s(])@(?:\p{Lu}[\p{L}'-]*(?: \p{Lu}[\p{L}'-]*){0,2}|[\w-]+)/gmu;

export function markMentions(content: string): string {
  return content
    .split(CODE_SPAN_OR_FENCE)
    .map((segment, index) =>
      // Odd indices are the captured code spans/fences themselves — `split`
      // with a capturing regex interleaves them with the surrounding text.
      index % 2 === 1 ? segment : segment.replace(MENTION_SHAPE, (mention) => `**${mention}**`)
    )
    .join('');
}
