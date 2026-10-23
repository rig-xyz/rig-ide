import type { RigFeed, RigFeedItem } from '@shared/rig/feed';
import type { FeedChoice, FeedItem, FeedVerb } from './model';

/**
 * The orchestrator's Feed (`rpc.rig.feed.get`) as Home's cards. Pure: the
 * relay sends situations with Rig's decision and a drafted card; Home shows
 * the visible ones, asks first. A card's one choice is its drafted action;
 * running it tells Rig the person handled it (`home-context.tsx`).
 */

const VERB: Record<string, FeedVerb> = { ask_you: 'reply', bring_in: 'space', do_it: 'start' };

/** `[item:ULY-280]` → `{ULY-280}` (a ref chip); refs with no readable name (messages, events) are dropped. */
export function refsToTokens(text: string): string {
  return text
    .replace(/\s*\[(?:item|ticket):([^\]\s]+)\]/g, ' {$1}')
    .replace(/\s*\[[a-z]+:[^\]\s]+\]/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

/** `**Reply to Riyad.** Answer the vendor question.` → lead "Reply to Riyad", tail ": answer the vendor question." */
export function splitAction(action: string): { lead: string; tail: string } {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(action.trim());
  const lead = (m ? m[1]! : action).trim().replace(/[.!]$/, '');
  const rest = (m ? m[2]! : '').trim();
  return { lead, tail: rest ? `: ${rest.charAt(0).toLowerCase()}${rest.slice(1)}` : '' };
}

export function age(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 2) return 'new';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function toFeedItem(x: RigFeedItem, now: number): FeedItem {
  const d = x.decision;
  const needs = d?.do === 'ask_you' || d?.do === 'bring_in';
  const verb = VERB[d?.do ?? ''] ?? 'start';
  const { lead, tail } = splitAction(x.card?.action || x.title);
  const choice: FeedChoice = {
    id: 'act',
    label: lead,
    verb,
    lead,
    tail,
    target: { kind: 'space', spaceId: '' },
  };
  return {
    id: `sit:${x.situationId}`,
    situationId: x.situationId,
    kind: needs ? 'ask' : 'session',
    group: needs ? 'needs_you' : 'up_next',
    status: 'shown',
    title: x.card?.title || x.title,
    why: refsToTokens(x.card?.why || x.description),
    choices: [choice],
    spaceId: '',
    people: [],
    tokenNotes: {},
    hasBrief: false,
    age: age(x.updatedAt, now),
  };
}

/** The visible cards, needs-you first, in Rig's order within each group. */
export function toFeedItems(feed: RigFeed, now: number): FeedItem[] {
  const items = feed.visible.map((x) => toFeedItem(x, now));
  return [
    ...items.filter((i) => i.group === 'needs_you'),
    ...items.filter((i) => i.group !== 'needs_you'),
  ];
}
