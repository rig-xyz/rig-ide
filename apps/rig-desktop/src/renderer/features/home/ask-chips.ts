/**
 * The chips under Home's Ask box, made from what's on Home right now (Dylan,
 * Home "lighter pass"): the space with the most unread, the person who
 * mentioned you and their topic, a topic that's new to you. A pure function
 * over Home's view model, no model call. With nothing new, the standing
 * three questions.
 */

import { firstNameKey, themeFaces } from './recent-themes-state';

export type AskChip = {
  question: string;
  /** Why it's offered, a few words on the chip ("25 new", "mentioned you"); null for the standing ones. */
  why: string | null;
};

export const FALLBACK_ASK_CHIPS: readonly AskChip[] = [
  { question: "What's blocked?", why: null },
  { question: 'What shipped recently?', why: null },
  { question: 'What should I pick up next?', why: null },
];

export type AskChipInput = {
  /** Each space and how many messages in it are unread. */
  spaces: readonly { bindingId: string; name: string; unread: number }[];
  /** Your unread mentions and replies by people, newest first: who, and in which space. */
  mentions: readonly { bindingId: string; spaceName: string; who: string }[];
  /** Today's topics, newest first, with whether each is new to you and who wrote in it. */
  topics: readonly { bindingId: string; spaceName: string; name: string; isNew: boolean; people: readonly string[] }[];
};

const MAX_CHIPS = 3;

export function deriveAskChips(input: AskChipInput): AskChip[] {
  const chips: AskChip[] = [];
  const usedTopics = new Set<string>();

  const busiest = [...input.spaces].filter((s) => s.unread > 0).sort((a, b) => b.unread - a.unread)[0];
  if (busiest) {
    chips.push({
      question: `Catch me up on ${busiest.name}`,
      why: `${busiest.unread > 99 ? '99+' : busiest.unread} new`,
    });
  }

  const mention = input.mentions[0];
  if (mention) {
    const who = mention.who.trim().split(/\s+/)[0] || mention.who;
    const key = firstNameKey(who);
    const inSpace = input.topics.filter((t) => t.bindingId === mention.bindingId);
    const topic =
      inSpace.find((t) => t.isNew && themeFaces(t.people).some((p) => firstNameKey(p) === key)) ??
      inSpace.find((t) => t.isNew) ??
      inSpace[0];
    if (topic) usedTopics.add(topic.name);
    chips.push({
      question: topic ? `What did ${who} decide on ${topic.name}?` : `What did ${who} ask me in ${mention.spaceName}?`,
      why: 'mentioned you',
    });
  }

  const fresh = input.topics.find((t) => t.isNew && !usedTopics.has(t.name));
  if (fresh) chips.push({ question: `What's left on ${fresh.name}?`, why: `#${fresh.spaceName}` });

  const unique = chips.filter((c, i) => chips.findIndex((d) => d.question === c.question) === i).slice(0, MAX_CHIPS);
  return unique.length > 0 ? unique : [...FALLBACK_ASK_CHIPS];
}
