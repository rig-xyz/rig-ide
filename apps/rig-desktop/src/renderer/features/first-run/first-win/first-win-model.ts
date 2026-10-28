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
  /** The ready cards, in the order they cycle; null until they're read. */
  cards: FeedEntry[] | null;
  /** The one in front. */
  at: number;
  done: FeedEntry[];
  /** One went (sent, posted or started): that's the win, and the first run ends on Home. */
  won: boolean;
};

export type FirstWinAction =
  /** The Feed's cards, read again as more land: new ones join the end, in their order. */
  | { type: 'loaded'; items: FeedItem[] }
  | { type: 'pick'; choiceId: string; slide: 'left' | 'right' }
  | { type: 'edit'; text: string | null }
  | { type: 'edit-draft'; text: string | null }
  | { type: 'reset' }
  | { type: 'starting' }
  | { type: 'failed'; error: string }
  | { type: 'sent'; result: SentResult }
  /** ‹ › or ▾ Show me another: the card before or after comes to the front, round the end. */
  | { type: 'step'; by: 1 | -1 }
  /** Not now, or Ignore: the front card leaves. */
  | { type: 'drop' };

export const initialFirstWin: FirstWinState = { cards: null, at: 0, done: [], won: false };

const entry = (item: FeedItem): FeedEntry => ({ item, edited: null, resetKey: 0, slide: null, ignored: false, fresh: false });

/** The card in front, if any. */
export function frontOf(state: FirstWinState): FeedEntry | undefined {
  return state.cards?.[state.at];
}

export function firstWinReducer(state: FirstWinState, action: FirstWinAction): FirstWinState {
  if (action.type === 'loaded') {
    if (!state.cards) return { ...state, cards: firstWinOrder(action.items).map(entry) };
    const seen = new Set([...state.cards, ...state.done].map((e) => e.item.id));
    const added = firstWinOrder(action.items.filter((i) => !seen.has(i.id))).map(entry);
    return added.length ? { ...state, cards: [...state.cards, ...added] } : state;
  }
  const cards = state.cards;
  const front = frontOf(state);
  if (!cards || !front || state.won) return state;
  const withFront = (e: FeedEntry): FirstWinState => ({ ...state, cards: cards.map((c, i) => (i === state.at ? e : c)) });
  // The front card gone: the next one comes forward, sliding in.
  const without = (): Pick<FirstWinState, 'cards' | 'at'> => {
    const rest = cards.filter((_, i) => i !== state.at);
    const at = rest.length ? state.at % rest.length : 0;
    return { cards: rest.map((c, i) => (i === at ? { ...c, fresh: true } : c)), at };
  };
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
      return { ...state, ...without(), done: [...state.done, { ...front, starting: false, sent: action.result }], won: true };
    case 'step': {
      if (cards.length < 2) return state;
      const at = (state.at + action.by + cards.length) % cards.length;
      return { ...state, at, cards: cards.map((c, i) => (i === at ? { ...c, fresh: true } : { ...c, fresh: false })) };
    }
    case 'drop':
      return { ...state, ...without() };
  }
}
