import { ok } from '@emdash/shared';
import type { FeedItem } from '@renderer/features/home-feed/model';
import type { FirstWinEnv } from '../env';

/**
 * The First win step's made-up cards, for the debug harness: the prototype's
 * people and tickets, each answer drafted. Nothing here is anyone's real
 * work, and a Send only pretends, after a moment.
 */

const SEND_MS = 1100;

const base = { kind: 'ask' as const, status: 'shown' as const, spaceId: '', tokenNotes: {}, hasBrief: false, age: '2d' };

export const FIRST_WIN_CARDS: FeedItem[] = [
  {
    ...base,
    id: 'sim:reply',
    situationId: 'sit_sim_reply',
    group: 'needs_you',
    title: 'Reply to Priya about Thursday’s pilot review',
    why: '{@Priya} asked in #product two days ago; nobody replied.',
    source: { connector: 'slack', scope: '#product', ref: '' },
    people: ['Priya Nair'],
    choices: [
      {
        id: 'c0', label: 'Say yes', verb: 'send', lead: 'Say yes, and ask for the numbers', tail: ': you’re free 14:00 to 16:00.',
        target: { kind: 'space', spaceId: '' }, cardIndex: 0,
        draft: { label: 'Your reply', text: 'Yes, I’ll be there. Could you share the pilot numbers before? I want to look at the KYC drop-off first.', target: 'msg:slack:CDEMOPRODUCT:1700000000.000100' },
      },
      {
        id: 'c1', label: 'Offer Friday', verb: 'send', lead: 'Offer Friday instead', tail: ': Thursday is tight, and the numbers can go async first.',
        target: { kind: 'space', spaceId: '' }, cardIndex: 1,
        draft: { label: 'Your reply', text: 'Thursday’s tight for me. Does Friday morning work? Happy to go through the numbers async before.', target: 'msg:slack:CDEMOPRODUCT:1700000000.000100' },
      },
      {
        id: 'c2', label: 'Hand it to Tom', verb: 'send', lead: 'Hand it to {@Tom}', tail: ': he knows the rate-limit side of the pilot best.',
        target: { kind: 'space', spaceId: '' }, cardIndex: 2,
        draft: { label: 'Your reply', text: 'I’m stretched Thursday. Tom knows the rate-limit side best. Tom, can you cover? I’ll read the notes after.', target: 'msg:slack:CDEMOPRODUCT:1700000000.000100' },
      },
    ],
  },
  {
    ...base,
    id: 'sim:review',
    situationId: 'sit_sim_review',
    group: 'needs_you',
    title: 'Post your review of Tom’s rate-limit PR',
    why: '{@Tom} asked for your review of {acme/api#212} two days ago.',
    source: { connector: 'github', scope: 'acme/api', ref: '#212' },
    people: ['Tom Becker'],
    choices: [
      {
        id: 'c0', label: 'Request changes', verb: 'post', lead: 'Request changes', tail: ': one blocking bug in the retry loop.',
        target: { kind: 'space', spaceId: '' }, cardIndex: 0,
        draft: { label: 'Review comment', text: 'Blocking: the retry loop in limiter.ts never backs off, so a 429 from the card network retries about 40 times a second. Suggest capped exponential backoff with jitter.', target: 'github:acme/api#212' },
      },
      {
        id: 'c1', label: 'Ask a question first', verb: 'post', lead: 'Ask a question first', tail: ': check the 429 path is covered by the load test.',
        target: { kind: 'space', spaceId: '' }, cardIndex: 1,
        draft: { label: 'Review comment', text: 'Before I review properly: is the 429 path covered by the load test? The retry loop looks like it never backs off.', target: 'github:acme/api#212' },
      },
    ],
  },
  {
    ...base,
    id: 'sim:fix',
    situationId: 'sit_sim_fix',
    kind: 'session',
    group: 'up_next',
    title: 'Draft the fix for the checkout timeout',
    why: '{LAR-91} is High and unassigned; saved-card checkouts time out.',
    source: { connector: 'linear', scope: 'LAR', ref: 'LAR-91' },
    people: [],
    choices: [
      { id: 'c0', label: 'Find the cause', verb: 'start', lead: 'Find the cause and draft a fix', tail: ': Claude traces it and opens a draft PR.', target: { kind: 'space', spaceId: '' }, cardIndex: 0 },
    ],
  },
];

/** First win in a simulation: these cards, and a Send or Start that succeeds after a moment. */
export function simulatedFirstWin(later: (ms: number, fn: () => void) => void): FirstWinEnv {
  const pretend = (said: string) => new Promise<ReturnType<typeof ok<{ said: string; link: string | null }>>>((resolve) => later(SEND_MS, () => resolve(ok({ said, link: null }))));
  return {
    cards: async () => FIRST_WIN_CARDS,
    send: (item, choice) => pretend(choice.verb === 'post' ? `Posted on ${item.source?.ref ? `api${item.source.ref}` : 'GitHub'}` : `Sent in ${item.source?.scope || 'Slack'}`),
    start: () => pretend('Started in #home'),
    answer: () => {},
  };
}
