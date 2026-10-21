import { demoFeed, demoSpaces } from './mock';
import type { FeedItem, RailSession, RailSpace } from './model';
import type { ReplyBlock } from './orchestrator';

/**
 * Home's state as one reducer: the demo half of the rail (real spaces are
 * merged in at render, `rail-data.ts`), the Feed, what the middle shows, the
 * chat, and the copies flying into the rail. Pure, so every move the Feed can
 * make is tested without a DOM.
 */

export type Selection =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'space'; id: string }
  | { kind: 'brief'; itemId: string };

export interface FeedEntry {
  item: FeedItem;
  /** The choice showing; the first one when unset. */
  pick?: string;
  /** The user's own text, or null while it's the proposal's. */
  edited: string | null;
  /** Bumped to throw away an edit (Undo, or a new choice) and redraw the proposal. */
  resetKey: number;
  /** Which side the text slides in from after a choice change. */
  slide: 'left' | 'right' | null;
  ignored: boolean;
  /** Just promoted into the Feed: it arrives from the side. */
  fresh: boolean;
}

export type ChatMessage =
  | { id: string; who: 'me'; text: string }
  /** `blocks: null` while Rig is typing. */
  | { id: string; who: 'rig'; blocks: ReplyBlock[] | null };

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type FlightLabel =
  | { kind: 'session'; name: string; queued?: boolean }
  | { kind: 'space'; name: string; people: string[] };

export interface Flight {
  id: string;
  from: Rect;
  /** The rail entry it lands on (`data-rail-id`). */
  targetId: string;
  label: FlightLabel;
}

export interface HomeState {
  demo: RailSpace[];
  /** Sessions started from Home in a space that isn't one of the demo ones. */
  extra: Record<string, RailSession[]>;
  feed: FeedEntry[];
  selection: Selection;
  collapsed: boolean;
  /** The Feed folded to its dock (by you, or because the window is narrow). */
  feedCollapsed: boolean;
  /** What the right panel shows: the Feed, or your connectors at work. */
  panel: 'feed' | 'connectors';
  messages: ChatMessage[];
  /** Brief and routine buttons already pressed, by `messageId:blockIndex`. */
  used: string[];
  flights: Flight[];
  /** The rail entry that just landed, and a counter so the same one can pulse twice. */
  landed: { id: string; n: number } | null;
}

export type HomeAction =
  | { type: 'collapse'; value: boolean }
  | { type: 'collapse-feed'; value: boolean }
  | { type: 'panel'; panel: 'feed' | 'connectors' }
  | { type: 'select'; selection: Selection }
  | { type: 'pick'; itemId: string; choiceId: string; slide: 'left' | 'right' }
  | { type: 'edit'; itemId: string; text: string | null }
  | { type: 'reset'; itemId: string }
  | { type: 'ignore'; itemId: string; value: boolean }
  | { type: 'remove'; itemId: string }
  | { type: 'add-item'; item: FeedItem }
  | { type: 'add-session'; spaceId: string; session: RailSession; atEnd?: boolean }
  | { type: 'update-session'; id: string; patch: Partial<RailSession>; step?: string }
  | { type: 'add-space'; space: RailSpace; index: number }
  | {
      type: 'move-session';
      sessionId: string;
      space: RailSpace;
      patch: Partial<RailSession>;
      steps: string[];
    }
  | { type: 'land'; id: string }
  | { type: 'fly'; flight: Flight }
  | { type: 'flight-done'; id: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message-blocks'; id: string; blocks: ReplyBlock[] }
  | { type: 'use'; key: string };

export function initialHomeState(): HomeState {
  return {
    demo: demoSpaces(),
    extra: {},
    feed: demoFeed().map((item) => ({
      item,
      edited: null,
      resetKey: 0,
      slide: null,
      ignored: false,
      fresh: false,
    })),
    selection: { kind: 'home' },
    collapsed: false,
    feedCollapsed: false,
    panel: 'feed',
    messages: [],
    used: [],
    flights: [],
    landed: null,
  };
}

function mapEntry(state: HomeState, itemId: string, fn: (e: FeedEntry) => FeedEntry): HomeState {
  return { ...state, feed: state.feed.map((e) => (e.item.id === itemId ? fn(e) : e)) };
}

function mapSessions(state: HomeState, fn: (s: RailSession) => RailSession): HomeState {
  return {
    ...state,
    demo: state.demo.map((sp) => ({ ...sp, sessions: sp.sessions.map(fn) })),
    extra: Object.fromEntries(Object.entries(state.extra).map(([k, list]) => [k, list.map(fn)])),
  };
}

export function homeReducer(state: HomeState, action: HomeAction): HomeState {
  switch (action.type) {
    case 'collapse':
      return { ...state, collapsed: action.value };
    case 'collapse-feed':
      return { ...state, feedCollapsed: action.value };
    case 'panel':
      return { ...state, panel: action.panel };
    case 'select':
      return { ...state, selection: action.selection };
    case 'pick':
      return mapEntry(state, action.itemId, (e) => ({
        ...e,
        pick: action.choiceId,
        edited: null,
        resetKey: e.resetKey + 1,
        slide: action.slide,
      }));
    case 'edit':
      return mapEntry(state, action.itemId, (e) => ({ ...e, edited: action.text }));
    case 'reset':
      return mapEntry(state, action.itemId, (e) => ({
        ...e,
        edited: null,
        resetKey: e.resetKey + 1,
        slide: null,
      }));
    case 'ignore':
      return mapEntry(state, action.itemId, (e) => ({ ...e, ignored: action.value }));
    case 'remove':
      return {
        ...state,
        feed: state.feed.filter((e) => e.item.id !== action.itemId),
        selection:
          state.selection.kind === 'brief' && state.selection.itemId === action.itemId
            ? { kind: 'home' }
            : state.selection,
      };
    case 'add-item': {
      if (state.feed.some((e) => e.item.id === action.item.id)) return state;
      const entry: FeedEntry = {
        item: action.item,
        edited: null,
        resetKey: 0,
        slide: null,
        ignored: false,
        fresh: true,
      };
      // New items lead their group: needs-you items first, then the rest.
      const firstOfGroup = state.feed.findIndex((e) => e.item.group === action.item.group);
      const at =
        firstOfGroup >= 0
          ? firstOfGroup
          : action.item.group === 'needs_you'
            ? 0
            : state.feed.length;
      const feed = [...state.feed];
      feed.splice(at, 0, entry);
      return { ...state, feed };
    }
    case 'add-session': {
      const add = (list: RailSession[]) =>
        action.atEnd ? [...list, action.session] : [action.session, ...list];
      if (state.demo.some((sp) => sp.id === action.spaceId)) {
        return {
          ...state,
          demo: state.demo.map((sp) =>
            sp.id === action.spaceId ? { ...sp, sessions: add(sp.sessions) } : sp
          ),
        };
      }
      return {
        ...state,
        extra: { ...state.extra, [action.spaceId]: add(state.extra[action.spaceId] ?? []) },
      };
    }
    case 'update-session':
      return mapSessions(state, (s) =>
        s.id === action.id
          ? {
              ...s,
              ...action.patch,
              steps: action.step
                ? [...s.steps.map((x) => ({ text: x.text })), { text: action.step, ago: 'now' }]
                : s.steps,
            }
          : s
      );
    case 'add-space': {
      if (state.demo.some((sp) => sp.id === action.space.id)) return state;
      const demo = [...state.demo];
      demo.splice(Math.min(action.index, demo.length), 0, action.space);
      return { ...state, demo };
    }
    case 'move-session': {
      let moved: RailSession | undefined;
      for (const sp of state.demo) moved ??= sp.sessions.find((s) => s.id === action.sessionId);
      if (!moved || state.demo.some((sp) => sp.id === action.space.id)) return state;
      const session: RailSession = {
        ...moved,
        ...action.patch,
        spaceId: action.space.id,
        steps: [
          ...moved.steps.map((x) => ({ text: x.text })),
          ...action.steps.map((text, i) => ({
            text,
            ago: i === action.steps.length - 1 ? 'now' : undefined,
          })),
        ],
      };
      const demo = state.demo.map((sp) => ({
        ...sp,
        sessions: sp.sessions.filter((s) => s.id !== action.sessionId),
      }));
      demo.splice(1, 0, { ...action.space, sessions: [session] });
      return { ...state, demo };
    }
    case 'land': {
      const cleared = mapSessions(state, (s) =>
        s.id === action.id && s.fresh ? { ...s, fresh: false } : s
      );
      return {
        ...cleared,
        demo: cleared.demo.map((sp) =>
          sp.id === action.id && sp.fresh ? { ...sp, fresh: false } : sp
        ),
        landed: { id: action.id, n: (state.landed?.n ?? 0) + 1 },
      };
    }
    case 'fly':
      return { ...state, flights: [...state.flights, action.flight] };
    case 'flight-done':
      return { ...state, flights: state.flights.filter((f) => f.id !== action.id) };
    case 'message':
      return { ...state, messages: [...state.messages, action.message] };
    case 'message-blocks':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id && m.who === 'rig' ? { ...m, blocks: action.blocks } : m
        ),
      };
    case 'use':
      return state.used.includes(action.key)
        ? state
        : { ...state, used: [...state.used, action.key] };
  }
}

/** Every session in the rail, with the space it sits in. */
export function findSession(
  spaces: readonly RailSpace[],
  id: string
): { space: RailSpace; session: RailSession } | null {
  for (const space of spaces) {
    const session = space.sessions.find((s) => s.id === id);
    if (session) return { space, session };
  }
  return null;
}

export function feedCounts(feed: readonly FeedEntry[]): { needsYou: number; upNext: number } {
  const live = feed.filter((e) => !e.ignored);
  return {
    needsYou: live.filter((e) => e.item.group === 'needs_you').length,
    upNext: live.filter((e) => e.item.group === 'up_next').length,
  };
}
