/**
 * Message reactions in a space (the relay's migration 0024): a person, or
 * one person's agent ("Maya's Claude"), puts an emoji on a room message.
 * A reaction is never a message: it never asks an agent and never triggers
 * anything. Shared by the Room (chips, picker), main's relay client, and
 * the room agent's tools and context, which only ever see counts.
 */

export type ReactionAgent = 'claude' | 'codex';

/** Who reacted: a person (`agent` null) or that person's agent. `userId` is null for someone no longer in the space. */
export type Reactor = { userId: string | null; agent: ReactionAgent | null };

/** One emoji on one message: how many, and who (in the order they reacted). */
export type MessageReaction = { emoji: string; count: number; reactors: Reactor[] };

/** The hover bar's five, and a new picker's "Frequently used" until you've used your own. */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '👀'];

/** How many reactions one agent turn may add. */
export const MAX_REACTIONS_PER_RUN = 10;

const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const VS16 = '️';

/**
 * The spelling the relay stores for one emoji (its RGI form: "❤" → "❤️",
 * "👍️" → "👍"), or null when `value` isn't exactly one emoji. Emoji data
 * sets don't agree on the presentation selector, so everything that sends
 * a reaction goes through this and two spellings never split a chip.
 */
export function canonicalEmoji(value: string): string | null {
  const emoji = value.trim();
  if (!emoji || emoji.length > 64) return null;
  const bare = emoji.replaceAll(VS16, '');
  return [emoji, bare, bare + VS16].find((spelling) => RGI_EMOJI.test(spelling)) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** A message's `reactions` as the relay sends them; anything malformed is dropped, never thrown. */
export function parseReactions(raw: unknown): MessageReaction[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageReaction[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    if (!r || typeof r.emoji !== 'string' || !Array.isArray(r.reactors)) continue;
    const reactors = r.reactors
      .map(asRecord)
      .filter((x): x is Record<string, unknown> => x !== null)
      .map(
        (x): Reactor => ({
          userId: typeof x.userId === 'string' ? x.userId : null,
          agent: x.agent === 'claude' || x.agent === 'codex' ? x.agent : null,
        })
      );
    const count =
      typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : reactors.length;
    if (count > 0) out.push({ emoji: r.emoji, count, reactors });
  }
  return out;
}

/**
 * What an agent is shown of a message's reactions: counts only, never who
 * ("👍 4 🎉 2"), so a reaction can't carry anyone's words into its context.
 * Empty when there are none.
 */
export function reactionCounts(reactions: readonly MessageReaction[] | undefined): string {
  return (reactions ?? [])
    .filter((r) => r.count > 0)
    .map((r) => `${r.emoji} ${r.count}`)
    .join(' ');
}

function sameReactor(a: Reactor, b: Reactor): boolean {
  return a.userId === b.userId && a.agent === b.agent;
}

/** Whether `reactor` has put `emoji` on these reactions. */
export function hasReacted(
  reactions: readonly MessageReaction[] | undefined,
  emoji: string,
  reactor: Reactor
): boolean {
  return !!reactions?.some(
    (r) => r.emoji === emoji && r.reactors.some((x) => sameReactor(x, reactor))
  );
}

/** `reactions` with `reactor`'s `emoji` added (`on`) or taken off — the Room's optimistic toggle, before the relay answers. */
export function withReaction(
  reactions: readonly MessageReaction[] | undefined,
  emoji: string,
  reactor: Reactor,
  on: boolean
): MessageReaction[] {
  const list = [...(reactions ?? [])];
  const index = list.findIndex((r) => r.emoji === emoji);
  const current = index === -1 ? null : list[index]!;
  const has = !!current?.reactors.some((x) => sameReactor(x, reactor));
  if (on === has) return list;
  if (on) {
    if (current)
      list[index] = { emoji, count: current.count + 1, reactors: [...current.reactors, reactor] };
    else list.push({ emoji, count: 1, reactors: [reactor] });
    return list;
  }
  const reactors = current!.reactors.filter((x) => !sameReactor(x, reactor));
  if (reactors.length === 0 && current!.count <= 1) list.splice(index, 1);
  else list[index] = { emoji, count: Math.max(0, current!.count - 1), reactors };
  return list;
}
