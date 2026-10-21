import type { SourceConnector } from './model';

/**
 * What Rig does in the background, for the Connectors view: each connector is
 * a watch session Claude runs on a schedule (rig README §2 "Sources"); what it
 * brings back lands in today's grid and is sorted into topics; what needs you
 * is promoted into the Feed, the rest is held back with a reason.
 *
 * Scripted for now (`connectors-script.ts` plays it), shaped like the relay's
 * items and topics (`docs/orchestrator-design.md` §6.4, §13) so real watch
 * sessions can replace it.
 */

export interface WatchedConnector {
  id: string;
  connector: SourceConnector;
  name: string;
  /** What it's scoped to: "Ulys", "rig-xyz/rig-ide", "your meetings". */
  scope: string;
  /** How often Claude checks: "every 30 min", "after each call". */
  cadence: string;
  checking: boolean;
  lastCheckAt: number;
  /** Items brought in today. */
  today: number;
  /** What the last check did, in its own words. */
  lastResult: { added: number; toFeed: number; held: number } | null;
}

export type TopicState = 'feed' | 'held' | 'none';

export interface TopicItem {
  ref: string;
  title: string;
  connector: SourceConnector;
  /** A note Rig added: "looks like ULY-245". */
  flag?: string;
}

export interface Topic {
  id: string;
  name: string;
  /** Which theme slot colors it (`--theme-1`…`--theme-8`), like a Room theme. */
  hue: number;
  count: number;
  /** Items that arrived since you last looked at it. */
  fresh: number;
  state: TopicState;
  /** Why Rig held it back, in plain words. */
  why?: string;
  items: TopicItem[];
  /** Bumped when something joins it, so its pill pulses. */
  bump: number;
}

export interface Cell {
  id: string;
  topic: string;
  ref: string;
  title: string;
  connector: SourceConnector;
  /** Just arrived: it pulses in. */
  fresh: boolean;
}

export interface ConnectorsState {
  connectors: WatchedConnector[];
  topics: Topic[];
  /** Today's items, oldest first. */
  cells: Cell[];
  focus: string | null;
}

/** One item a check brings back. */
export interface Arrival {
  connector: SourceConnector;
  ref: string;
  title: string;
  topic: string;
  /** A topic this item starts. */
  born?: { name: string; hue: number };
  flag?: string;
  /** It needs you: it goes to the Feed. */
  toFeed?: boolean;
  /** Rig keeps it out of your way. */
  held?: boolean;
}

export type ConnectorsAction =
  | { type: 'check-start'; connector: SourceConnector }
  | { type: 'check-done'; connector: SourceConnector; at: number; arrivals: Arrival[] }
  | { type: 'settle' }
  | { type: 'focus'; topic: string | null }
  | { type: 'topic-state'; topic: string; state: TopicState; why?: string };

export function connectorsReducer(
  state: ConnectorsState,
  action: ConnectorsAction
): ConnectorsState {
  switch (action.type) {
    case 'check-start':
      return {
        ...state,
        connectors: state.connectors.map((c) =>
          c.connector === action.connector ? { ...c, checking: true } : c
        ),
      };
    case 'check-done': {
      let topics = state.topics;
      const cells = [...state.cells];
      for (const a of action.arrivals) {
        if (!topics.some((t) => t.id === a.topic) && a.born) {
          topics = [
            ...topics,
            {
              id: a.topic,
              name: a.born.name,
              hue: a.born.hue,
              count: 0,
              fresh: 0,
              state: 'none',
              items: [],
              bump: 0,
            },
          ];
        }
        topics = topics.map((t) =>
          t.id === a.topic
            ? {
                ...t,
                count: t.count + 1,
                fresh: t.fresh + 1,
                bump: t.bump + 1,
                state: a.toFeed ? 'feed' : t.state,
                items: [
                  { ref: a.ref, title: a.title, connector: a.connector, flag: a.flag },
                  ...t.items,
                ],
              }
            : t
        );
        cells.push({
          id: `${a.connector}:${a.ref}`,
          topic: a.topic,
          ref: a.ref,
          title: a.title,
          connector: a.connector,
          fresh: true,
        });
      }
      const result = {
        added: action.arrivals.length,
        toFeed: action.arrivals.filter((a) => a.toFeed).length,
        held: action.arrivals.filter((a) => a.held).length,
      };
      return {
        ...state,
        topics,
        cells,
        connectors: state.connectors.map((c) =>
          c.connector === action.connector
            ? {
                ...c,
                checking: false,
                lastCheckAt: action.at,
                today: c.today + result.added,
                lastResult: result,
              }
            : c
        ),
      };
    }
    case 'settle':
      return state.cells.some((c) => c.fresh)
        ? { ...state, cells: state.cells.map((c) => (c.fresh ? { ...c, fresh: false } : c)) }
        : state;
    case 'focus':
      return {
        ...state,
        focus: action.topic,
        // Looking at a topic is seeing what's new in it.
        topics: action.topic
          ? state.topics.map((t) => (t.id === action.topic ? { ...t, fresh: 0 } : t))
          : state.topics,
      };
    case 'topic-state':
      return {
        ...state,
        topics: state.topics.map((t) =>
          t.id === action.topic ? { ...t, state: action.state, why: action.why ?? t.why } : t
        ),
      };
  }
}

/** What a connector's last check did, in a few words. */
export function resultLine(c: Pick<WatchedConnector, 'lastResult'>): string {
  const r = c.lastResult;
  if (!r) return 'Not checked yet today';
  if (r.added === 0) return 'nothing new';
  const parts = [`${r.added} new`];
  if (r.toFeed) parts.push(`${r.toFeed} to your Feed`);
  if (r.held) parts.push(`${r.held} held back`);
  return parts.join(', ');
}

/** "just now", "4m ago", "2h ago". */
export function agoShort(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
