import { SOURCES } from './mock';
import type { FeedChoice, FeedItem, FeedVerb, RailSpace } from './model';

/**
 * The proposal text: tokens, the sentence a choice says, and the labels a
 * choice puts on the item (the space in one word, the button's verb).
 */

export type TokenKind = 'person' | 'space' | 'new-space' | 'ref';

export type SaySegment =
  | { kind: 'text'; text: string }
  | { kind: 'token'; token: TokenKind; text: string };

/** Splits `Ask {@Riyad} to decide` into text and token segments. */
export function parseSay(text: string): SaySegment[] {
  const out: SaySegment[] = [];
  const pattern = /\{([^}]+)\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    out.push({ kind: 'token', token: tokenKind(match[1]!), text: match[1]! });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function tokenKind(raw: string): TokenKind {
  if (raw.startsWith('@')) return 'person';
  if (raw.startsWith('#')) return 'space';
  if (raw === 'new space') return 'new-space';
  return 'ref';
}

/** The text with its tokens unwrapped, as the user would read or edit it. */
export function plainSay(text: string): string {
  return text.replace(/\{([^}]+)\}/g, '$1');
}

/** `: he owns account restrictions` → `He owns account restrictions.` */
export function tailSentence(tail: string): string {
  const x = tail.replace(/^[:,.]\s*/, '').trim();
  if (!x) return '';
  const y = x[0]!.toUpperCase() + x.slice(1);
  return /[.!?]$/.test(y) ? y : `${y}.`;
}

/** The three parts a choice's text is made of: the bold action, the item's context, what it means. */
export function sayParts(
  item: Pick<FeedItem, 'why'>,
  choice: Pick<FeedChoice, 'lead' | 'tail'>
): {
  lead: string;
  context: string;
  tail: string;
} {
  return { lead: `${choice.lead}.`, context: item.why, tail: tailSentence(choice.tail) };
}

/** The whole proposal for a choice, plain: what editing starts from and what Undo returns to. */
export function sayPlain(
  item: Pick<FeedItem, 'why'>,
  choice: Pick<FeedChoice, 'lead' | 'tail'>
): string {
  const { lead, context, tail } = sayParts(item, choice);
  return plainSay([lead, context, tail].filter(Boolean).join(' '));
}

/** Folds whitespace the way a contenteditable's text comes back. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Where the item happens, in one word: `#ulys-backlog`, or "New space". */
export function spaceLabel(
  item: Pick<FeedItem, 'spaceId' | 'source'>,
  choice: FeedChoice,
  spaces: readonly RailSpace[]
): string {
  if (choice.verb === 'space') return 'New space';
  const id =
    choice.target.kind === 'new-session' || choice.target.kind === 'space'
      ? choice.target.spaceId
      : item.spaceId;
  const space = spaces.find((s) => s.id === id || s.bindingId === id);
  if (space) return `#${space.name}`;
  // A card from your own tools, not from a space: say where it came from.
  if (!id) return item.source ? SOURCES[item.source.connector].name : 'Rig';
  return `#${id}`;
}

export const VERB_LABEL: Record<FeedVerb, string> = {
  reply: 'Reply',
  start: 'Start session',
  space: 'Create space',
  open: 'Open',
  send: 'Send',
  post: 'Post',
};

/** The choice that's showing: the picked one, else the first. */
export function chosen(item: Pick<FeedItem, 'choices'>, pickId: string | undefined): FeedChoice {
  return item.choices.find((c) => c.id === pickId) ?? item.choices[0]!;
}

/** Steps through the choices, wrapping at both ends. */
export function stepChoice(
  item: Pick<FeedItem, 'choices'>,
  pickId: string | undefined,
  by: number
): FeedChoice {
  const list = item.choices;
  const from = Math.max(
    0,
    list.findIndex((c) => c.id === chosen(item, pickId).id)
  );
  return list[(from + by + list.length) % list.length]!;
}

/** "1 thing needs you", "2 things need you". */
export function needsYouPhrase(n: number): string {
  return n === 1 ? '1 thing needs you' : `${n} things need you`;
}
