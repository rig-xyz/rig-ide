import type { RigFeed, RigFeedItem } from '@shared/rig/feed';
import type { FeedChoice, FeedItem, FeedVerb, Person, SourceConnector } from './model';

/**
 * The orchestrator's Feed (`rpc.rig.feed.get`) as Home's cards, the same
 * shape as the prototype's: a source and the people involved on top, the
 * drafted choices in the carousel, ticket refs as chips and people as
 * {@Name} tokens. Pure. Running a choice is in `home-context.tsx`: Start
 * and Reply start a session, Open opens the card's source. Bringing people
 * in from a card isn't built yet, so those choices aren't offered.
 */

const VERB: Record<string, FeedVerb> = { ask_you: 'reply', bring_in: 'reply', do_it: 'start' };
/** The connector a card shows when its events came from several. */
const SOURCE_ORDER: SourceConnector[] = ['linear', 'github', 'slack', 'gmail', 'granola'];

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

/** A face for anyone Rig names: their initial on a stable hue. */
export function personFor(name: string): Person {
  const hue = ([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 7) + 1;
  return { id: name, name, hue };
}

/**
 * `{@Hugo Renaudin}` → `{@Hugo}`, as the demo writes people, with the full
 * name kept as the token's note. Two people sharing a first name keep theirs.
 */
export function firstNames(people: string[]): { short: (text: string) => string; notes: Record<string, string> } {
  const first = (n: string) => n.split(/\s+/)[0] ?? n;
  const label = new Map(people.map((p) => [p, people.filter((q) => first(q) === first(p)).length > 1 ? p : first(p)]));
  return {
    short: (text) => text.replace(/\{@([^}]+)\}/g, (m, name: string) => (label.has(name.trim()) ? `{@${label.get(name.trim())}}` : m)),
    notes: Object.fromEntries(people.map((p) => [`@${label.get(p)}`, p])),
  };
}

const tail = (t: string) => (!t ? '' : /^[:,.]/.test(t.trim()) ? t.trim().replace(/^([:,.])\s*/, '$1 ') : `: ${t.trim()}`);

export function toFeedItem(x: RigFeedItem, now: number): FeedItem {
  const d = x.decision;
  const needs = d?.do === 'ask_you' || d?.do === 'bring_in';
  const drafted = (x.card?.choices ?? []).filter((c) => c.verb !== 'space');
  const fallback = splitAction(x.card?.action || x.title);
  const people = x.card?.people?.length ? x.card.people : [];
  const names = firstNames(people);
  const options = drafted.length ? drafted : [{ verb: VERB[d?.do ?? ''] ?? 'start', label: '', lead: fallback.lead, tail: fallback.tail }];
  const choices: FeedChoice[] = options.map((c, i) => ({
    id: `c${i}`,
    label: c.label || c.lead,
    verb: c.verb as FeedVerb,
    lead: names.short(refsToTokens(c.lead)),
    tail: tail(names.short(refsToTokens(c.tail))),
    target: { kind: 'space', spaceId: x.bindingId ?? '' },
  }));
  const connector = SOURCE_ORDER.find((s) => (x.sources ?? []).includes(s));
  return {
    id: `sit:${x.situationId}`,
    situationId: x.situationId,
    kind: needs ? 'ask' : 'session',
    group: needs ? 'needs_you' : 'up_next',
    status: 'shown',
    title: x.card?.title || x.title,
    why: names.short(refsToTokens(x.card?.why || x.description)),
    choices,
    spaceId: x.bindingId ?? '',
    ...(connector ? { source: { connector, scope: '', ref: '' } } : {}),
    people,
    tokenNotes: names.notes,
    hasBrief: false,
    age: age(x.updatedAt, now),
  };
}

/**
 * The visible cards, needs-you first, in Rig's order within each group. A
 * card Rig hasn't drafted yet waits, rather than show the raw situation.
 */
export function toFeedItems(feed: RigFeed, now: number): FeedItem[] {
  const items = feed.visible.filter((x) => x.card).map((x) => toFeedItem(x, now));
  return [...items.filter((i) => i.group === 'needs_you'), ...items.filter((i) => i.group !== 'needs_you')];
}
