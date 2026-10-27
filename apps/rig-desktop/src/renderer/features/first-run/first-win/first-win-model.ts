import type { FeedItem } from '@renderer/features/home-feed/model';
import type { FeedEntry, SentResult } from '@renderer/features/home-feed/store';

/**
 * The First win step's state: the Feed's cards as a queue, the one in front
 * shown as a real Feed row, and the ones already done above it. Pure, so the
 * step and its tests share it.
 */

const drafted = (item: FeedItem) => item.choices.some((c) => (c.verb === 'send' || c.verb === 'post') && c.draft);

/** The cards in the order the step shows them: a drafted answer first (one click to a win), then what needs you, then the rest. */
export function firstWinOrder(items: FeedItem[]): FeedItem[] {
  const rank = (i: FeedItem) => (drafted(i) ? 0 : 1) + (i.group === 'needs_you' ? 0 : 2);
  return items
    .map((item, at) => ({ item, at }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.at - b.at)
    .map((x) => x.item);
}

export type FirstWinState = {
  /** null until the cards are read; [] when there are none. */
  queue: FeedEntry[] | null;
  done: FeedEntry[];
  /** What the guide says about the card in front. */
  front: 'first' | 'another' | 'next';
  /** One went (sent, posted or started): that's the win, and the first run ends on Home. */
  won: boolean;
};

export type FirstWinAction =
  | { type: 'loaded'; items: FeedItem[] }
  | { type: 'pick'; choiceId: string; slide: 'left' | 'right' }
  | { type: 'edit'; text: string | null }
  | { type: 'edit-draft'; text: string | null }
  | { type: 'reset' }
  | { type: 'starting' }
  | { type: 'failed'; error: string }
  | { type: 'sent'; result: SentResult }
  /** ▾ Show me another: the front card goes to the back. */
  | { type: 'another' }
  /** Not now, or Ignore: the front card leaves. */
  | { type: 'drop' };

export const initialFirstWin: FirstWinState = { queue: null, done: [], front: 'first', won: false };

const entry = (item: FeedItem): FeedEntry => ({ item, edited: null, resetKey: 0, slide: null, ignored: false, fresh: false });

export function firstWinReducer(state: FirstWinState, action: FirstWinAction): FirstWinState {
  if (action.type === 'loaded') return { ...state, queue: firstWinOrder(action.items).map(entry) };
  const queue = state.queue;
  const front = queue?.[0];
  if (!queue || !front) return state;
  const withFront = (e: FeedEntry): FirstWinState => ({ ...state, queue: [e, ...queue.slice(1)] });
  switch (action.type) {
    case 'pick':
      return withFront({ ...front, pick: action.choiceId, edited: null, draftEdit: null, failed: null, resetKey: front.resetKey + 1, slide: action.slide });
    case 'edit':
      return withFront({ ...front, edited: action.text });
    case 'edit-draft':
      return withFront({ ...front, draftEdit: action.text });
    case 'reset':
      return withFront({ ...front, edited: null, draftEdit: null, resetKey: front.resetKey + 1, slide: null });
    case 'starting':
      return withFront({ ...front, starting: true, failed: null });
    case 'failed':
      return withFront({ ...front, starting: false, failed: action.error });
    // The win: its done card stays a moment, then the first run ends; no next card comes forward.
    case 'sent':
      return { ...state, queue: queue.slice(1), done: [...state.done, { ...front, starting: false, sent: action.result }], won: true };
    case 'another':
      return queue.length < 2 ? state : { ...state, queue: [...queue.slice(1).map((e, i) => (i === 0 ? { ...e, fresh: true } : e)), { ...front, fresh: false }], front: 'another' };
    case 'drop':
      return { ...state, queue: queue.slice(1).map((e, i) => (i === 0 ? { ...e, fresh: true } : e)), front: 'next' };
  }
}
