import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { toast as appToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { RigFeedSignal } from '@shared/rig/feed';
import {
  type Arrival,
  type ConnectorsAction,
  connectorsReducer,
  type ConnectorsState,
} from './connectors-model';
import { CHECKS, initialConnectorsState, TIMING } from './connectors-script';
import { ARRIVAL, PEOPLE, topicSuggestion } from './mock';
import type { FeedChoice, RailSession, RailSpace, SourceConnector, SourceRef } from './model';
import {
  type HomeOrchestrator,
  type OrchestratorContext,
  scriptedOrchestrator,
} from './orchestrator';
import type { HomeChatRun } from '@shared/rig/home-chat';
import { mergeRail } from './rail-data';
import { type RealFeed, useRealFeed } from './use-real-feed';
import { claudeOrchestrator } from './claude-orchestrator';
import { sendToHomeClaude, useHomeRuns } from './home-claude';
import { chosen, normalizeText, sayPlain } from './say';
import {
  feedCounts,
  findSession,
  type FlightLabel,
  type HomeAction,
  homeReducer,
  type HomeState,
  initialHomeState,
  type Rect,
  type Selection,
} from './store';

/**
 * Home's state and the moves people make on it. Components read `useHome()`;
 * the scripted parts (what a started session does next, the arrival of a new
 * item) live here, behind the same actions a relay-backed Home would call.
 */

export interface HomeApi {
  state: HomeState;
  dispatch: Dispatch<HomeAction>;
  /** Where the Feed stands: its cards, or why there are none (signed out, can't reach, unsupported). */
  feedStatus: RealFeed;
  /** The scripted demo is showing (dev builds that ask for it, with no real Feed). */
  demo: boolean;
  /** Real spaces, and the demo's while it shows, as the rail shows them. */
  spaces: RailSpace[];
  counts: { needsYou: number; upNext: number };
  firstName: string;
  reducedMotion: boolean;
  orchestrator: HomeOrchestrator;
  orchestratorContext: OrchestratorContext;
  open: (selection: Selection) => void;
  runItem: (itemId: string, from: Rect | null) => void;
  startSession: (spaceId: string, name: string, from: Rect | null, opts?: StartOptions) => void;
  bringIn: (sessionId: string, from: Rect | null) => void;
  addRoutine: (name: string, from: Rect | null) => void;
  send: (text: string) => void;
  /** Home's own Claude, live, once the real Feed is on: the chat shows its runs like a Room and `send` goes to it. */
  homeRuns: HomeChatRun[] | null;
  toast: (text: string) => void;
  /** Opens a real space or session in the app (its Room or its chat). */
  /** Opens a space in the app; with a session (a rail one, or a chat by id), that session. */
  openInApp: (target: { space: RailSpace; session?: RailSession; sessionId?: string }) => void;
  /** Your connectors at work: what each watch session brought back and how it was sorted. */
  connectors: ConnectorsState;
  connectorsDispatch: Dispatch<ConnectorsAction>;
  /** Has Claude check a connector now, out of its schedule. */
  checkNow: (connector: SourceConnector) => void;
  /** Puts a topic in your Feed as a suggestion. */
  promoteTopic: (topicId: string) => void;
  /** Tells Rig how the person answered a real card (`item.situationId`); a no-op on demo items. */
  answerCard: (itemId: string, signal: RigFeedSignal, detail?: { choice?: string; reason?: string }) => void;
}

interface StartOptions {
  source?: SourceRef;
  background?: boolean;
  note?: string;
}

const HomeContext = createContext<HomeApi | null>(null);

export function useHome(): HomeApi {
  const api = useContext(HomeContext);
  if (!api) throw new Error('useHome outside HomeProvider');
  return api;
}

function wait(ms: number, reduced: boolean): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, reduced ? 0 : ms));
}

export function rectOf(el: Element | null | undefined): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function HomeProvider({
  realSpaces,
  selfName,
  reducedMotion,
  orchestrator: givenOrchestrator = scriptedOrchestrator,
  onOpenPath,
  onContinueSession,
  arrivals = true,
  demo = false,
  children,
}: {
  realSpaces: RailSpace[];
  selfName: string | null;
  reducedMotion: boolean;
  orchestrator?: HomeOrchestrator;
  onOpenPath: (path: string, opts?: { kind?: 'space' }) => void;
  onContinueSession: (path: string, sessionId: string) => void;
  /** The scripted arrival of a new Feed item, in the demo; off in tests. */
  arrivals?: boolean;
  /**
   * Show the scripted demo while there is no real Feed. Dev builds only
   * (`new-home.tsx`): a real install shows why its Feed is empty instead.
   */
  demo?: boolean;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(homeReducer, undefined, initialHomeState);
  // The orchestrator's Feed, as soon as the relay has it. Without one, Home
  // says why (signed out, can't reach); only a dev build that asks for it
  // shows the scripted demo instead.
  const realFeed = useRealFeed();
  const ready = realFeed.kind === 'ready' ? realFeed : null;
  const demoOn = demo && !ready && realFeed.kind !== 'loading';
  const realFeedOn = useRef(false);
  useEffect(() => {
    if (!ready) return;
    realFeedOn.current = true;
    dispatch({ type: 'replace-feed', items: ready.items });
  }, [ready]);
  const shown = useMemo(() => {
    if (demoOn) return state;
    // A Feed already shown stays while the relay is briefly out of reach; signed out, it goes.
    const keep = state.fromRelay && (ready !== null || realFeed.kind === 'unreachable');
    return { ...state, fromRelay: true, feed: keep ? state.feed : [] };
  }, [demoOn, ready, realFeed.kind, state]);
  // Outside the demo, the chat is the person's own Claude, which can correct the Feed.
  const orchestrator = demoOn ? givenOrchestrator : claudeOrchestrator;
  // (A dev build showing the demo opens it only once a real Feed comes.)
  const homeRuns = useHomeRuns(!demo || ready !== null);
  const [connectors, connectorsDispatch] = useReducer(connectorsReducer, undefined, () =>
    initialConnectorsState(Date.now())
  );
  const connectorsRef = useRef(connectors);
  connectorsRef.current = connectors;
  const stateRef = useRef(state);
  /** Cards whose Start is setting up a session right now. */
  const startingRef = useRef(new Set<string>());
  stateRef.current = state;

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = useCallback(
    (ms: number, fn: () => void) => {
      const t = setTimeout(
        () => {
          timers.current.delete(t);
          fn();
        },
        reducedMotion ? Math.min(ms, 400) : ms
      );
      timers.current.add(t);
    },
    [reducedMotion]
  );
  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
      set.clear();
    };
  }, []);

  const spaces = useMemo(
    // Outside the demo, the rail shows only your real spaces.
    () => mergeRail(realSpaces, demoOn ? state.demo : [], new Map(Object.entries(state.extra))),
    [realSpaces, state.demo, state.extra, demoOn]
  );
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  const counts = feedCounts(shown.feed);
  const firstName = (selfName ?? ready?.me ?? 'there').split(/\s+/)[0] ?? 'there';

  const orchestratorContext = useMemo<OrchestratorContext>(
    () => ({
      firstName,
      needsYou: counts.needsYou,
      upNext: counts.upNext,
      defaultSpaceId: spaces[0]?.id ?? 'ulys-backlog',
      spaceIds: spaces.map((s) => s.id),
    }),
    [firstName, counts.needsYou, counts.upNext, spaces]
  );

  // The app's own alert cards (sonner, `lib/hooks/use-toast`).
  const toast = useCallback((text: string) => {
    appToast({ title: text });
  }, []);

  const open = useCallback((selection: Selection) => {
    dispatch({ type: 'select', selection });
    if (selection.kind === 'session' || selection.kind === 'space')
      dispatch({ type: 'land', id: selection.id });
  }, []);

  const nextId = useRef(0);
  const landings = useRef(new Map<string, () => void>());
  const fly = useCallback(
    (from: Rect | null, targetId: string, label: FlightLabel, onLand?: () => void) => {
      const id = `f${++nextId.current}`;
      if (!from || reducedMotion || stateRef.current.collapsed) {
        // Nothing to fly from, or no room to show it: land at once, still with the pulse.
        requestAnimationFrame(() => {
          dispatch({ type: 'land', id: targetId });
          onLand?.();
        });
        return;
      }
      landings.current.set(id, () => {
        dispatch({ type: 'land', id: targetId });
        onLand?.();
      });
      dispatch({ type: 'fly', flight: { id, from, targetId, label } });
    },
    [reducedMotion]
  );

  const startSession = useCallback(
    (spaceId: string, name: string, from: Rect | null, opts: StartOptions = {}) => {
      const id = `s-new${++nextId.current}`;
      const bg = !!opts.background;
      const session: RailSession = {
        id,
        spaceId,
        name,
        state: 'starting',
        fresh: true,
        source: opts.source,
        short: bg ? 'In the background' : 'Starting',
        summary: bg ? 'Running in the background; reports when done.' : 'Just started from Home.',
        last: { who: 'Claude', text: 'Reading the brief', ago: 'now' },
        steps: [
          { text: 'Read the brief' },
          ...(opts.note ? [{ text: `Your instructions: ${opts.note}` }] : []),
        ],
        origin: 'mock',
      };
      dispatch({ type: 'add-session', spaceId, session });
      fly(from, id, { kind: 'session', name }, () => {
        later(1600, () =>
          dispatch({
            type: 'update-session',
            id,
            patch: {
              state: 'running',
              activity: 'reading',
              short: bg ? 'In the background' : 'Opening the items',
              last: { who: 'Claude', text: 'Opening the items in the brief', ago: 'now' },
            },
            step: 'Opening the items in the brief',
          })
        );
        later(4200, () =>
          dispatch({
            type: 'update-session',
            id,
            patch: {
              state: 'running',
              activity: bg ? 'running' : 'editing',
              short: bg ? 'In the background · 1 of 3' : 'Working on item 1',
              last: { who: 'Claude', text: 'Working through the first item', ago: 'now' },
            },
            step: 'Working through the first item',
          })
        );
      });
    },
    [fly, later]
  );

  const bringIn = useCallback(
    (sessionId: string, from: Rect | null) => {
      const found = findSession(spacesRef.current, sessionId);
      if (!found || found.space.id === 'urgent-triage') {
        toast('Riyad is already in #urgent-triage');
        return;
      }
      const space: RailSpace = {
        id: 'urgent-triage',
        name: 'urgent-triage',
        visibility: 'shared',
        faces: [PEOPLE.riyad!],
        unread: 0,
        summary:
          "Cut from your triage session: the brief, Claude's findings and 3 tickets. Riyad is invited.",
        sessions: [],
        origin: 'mock',
        fresh: true,
      };
      dispatch({
        type: 'move-session',
        sessionId,
        space,
        patch: {
          state: 'waiting_on_person',
          short: 'Waiting for Riyad',
          summary: 'Waiting for Riyad on ULY-429. The other two are done.',
          last: { who: 'Claude', text: 'Waiting for Riyad on ULY-429', ago: 'now' },
        },
        steps: ['Moved to #urgent-triage and invited Riyad', 'Waiting for Riyad on ULY-429'],
      });
      const ask = stateRef.current.feed.find(
        (e) => e.item.sessionId === sessionId && e.item.kind === 'ask'
      );
      if (ask) dispatch({ type: 'remove', itemId: ask.item.id });
      fly(from, space.id, { kind: 'space', name: space.name, people: ['riyad'] }, () =>
        toast('Made #urgent-triage and invited Riyad')
      );
    },
    [fly, toast]
  );

  const createSpace = useCallback(
    (choice: FeedChoice, source: SourceRef | undefined, from: Rect | null) => {
      if (choice.target.kind !== 'new-space') return;
      const { name, people } = choice.target;
      const sessionId = `${name}-daily`;
      const space: RailSpace = {
        id: name,
        name,
        visibility: 'shared',
        faces: people.map((p) => PEOPLE[p]).filter((p): p is NonNullable<typeof p> => !!p),
        unread: 0,
        summary:
          'Season 1 Loyalty Launch: 42 items. Anthony, Natalie and Harold invited; Claude posts a daily status.',
        origin: 'mock',
        fresh: true,
        sessions: [
          {
            id: sessionId,
            spaceId: name,
            name: 'Daily launch status',
            state: 'starting',
            source,
            short: 'Starting',
            summary:
              'Posts what moved, what stalled and who is blocked, every morning until launch.',
            last: { who: 'Claude', text: 'Reading the items', ago: 'now' },
            steps: [{ text: 'Read the brief' }],
            origin: 'mock',
          },
        ],
      };
      dispatch({ type: 'add-space', space, index: 1 });
      fly(from, space.id, { kind: 'space', name, people }, () =>
        later(1600, () =>
          dispatch({
            type: 'update-session',
            id: sessionId,
            patch: { state: 'running', activity: 'reading', short: 'Reading 42 tickets' },
            step: 'Reading 42 tickets',
          })
        )
      );
    },
    [fly, later]
  );

  const answerCard = useCallback(
    (itemId: string, signal: RigFeedSignal, detail: { choice?: string; reason?: string } = {}) => {
      const item = stateRef.current.feed.find((e) => e.item.id === itemId)?.item;
      if (!item?.situationId) return;
      void rpc.rig.feed
        .answer({ situationId: item.situationId, signal, choice: detail.choice ?? detail.reason })
        .then((r) => {
          if (!r.success) toast(r.error.message);
        });
    },
    [toast]
  );

  const runItem = useCallback(
    (itemId: string, from: Rect | null) => {
      const entry = stateRef.current.feed.find((e) => e.item.id === itemId);
      if (!entry) return;
      const { item } = entry;
      // A real card: Start runs the session it proposes; the other verbs tell Rig it's handled.
      if (item.situationId) {
        const situationId = item.situationId;
        if (chosen(item, entry.pick).verb === 'space') {
          toast('Bringing people in from a card comes next. Ask in the chat for now.');
          return;
        }
        if (chosen(item, entry.pick).verb === 'start') {
          // Start the session the card proposes, in the card's own space; its result comes back to the card.
          // Setting it up takes a few seconds: say so at once, and ignore more clicks meanwhile.
          if (startingRef.current.has(situationId)) return;
          startingRef.current.add(situationId);
          const choice = chosen(item, entry.pick);
          // The card's button says "Starting…" until the session runs; then the card leaves and the session shows in the rail.
          dispatch({ type: 'starting', itemId, value: true });
          void rpc.rig.feed
            .start({ situationId, task: `${choice.lead}${choice.tail}`.replace(/[{}@]/g, '') })
            .then((r) => {
              if (!r.success) {
                dispatch({ type: 'starting', itemId, value: false });
                return toast(r.error.message);
              }
              dispatch({ type: 'remove', itemId });
            })
            .finally(() => startingRef.current.delete(situationId));
          return;
        }
        dispatch({ type: 'remove', itemId });
        answerCard(itemId, 'act', { choice: chosen(item, entry.pick).label });
        toast('Done. Rig will bring it back if something new happens.');
        return;
      }
      const choice = chosen(item, entry.pick);
      const text = normalizeText(entry.edited ?? sayPlain(item, choice));
      const target = choice.target;
      switch (choice.verb) {
        case 'reply': {
          if (target.kind === 'session') {
            dispatch({
              type: 'update-session',
              id: target.sessionId,
              patch: {
                state: 'running',
                activity: 'editing',
                short: 'Working on your reply',
                last: { who: 'Claude', text: 'Working on your reply', ago: 'now' },
              },
              step: `You: ${text}`,
            });
          }
          dispatch({ type: 'remove', itemId });
          toast('Replied. Claude picks it up now.');
          return;
        }
        case 'open': {
          if (target.kind === 'session') open({ kind: 'session', id: target.sessionId });
          else if (target.kind === 'space') open({ kind: 'space', id: target.spaceId });
          return;
        }
        case 'space': {
          if (target.kind !== 'new-space') return;
          if (target.fromSessionId) {
            dispatch({
              type: 'update-session',
              id: target.fromSessionId,
              patch: {},
              step: `You: ${text}`,
            });
            bringIn(target.fromSessionId, from);
          } else {
            createSpace(choice, item.source, from);
            dispatch({ type: 'remove', itemId });
          }
          return;
        }
        case 'start': {
          const spaceId = target.kind === 'new-session' ? target.spaceId : item.spaceId;
          dispatch({ type: 'remove', itemId });
          startSession(spaceId, item.title, from, {
            source: item.source,
            background: target.kind === 'new-session' && !!target.background,
            note: entry.edited ? text : undefined,
          });
          return;
        }
      }
    },
    [answerCard, bringIn, createSpace, open, startSession, toast]
  );

  const addRoutine = useCallback(
    (name: string, from: Rect | null) => {
      const id = `s-routine${++nextId.current}`;
      const spaceId = spacesRef.current[0]?.id ?? 'ulys-backlog';
      dispatch({
        type: 'add-session',
        spaceId,
        atEnd: true,
        session: {
          id,
          spaceId,
          name: `Routine: ${name}`,
          state: 'queued',
          fresh: true,
          source: { connector: 'linear', scope: 'Ulys', ref: 'Earn tickets' },
          short: 'Next run Monday 9:00',
          summary:
            'Runs Mondays at 9:00 as a background session. Saved as .rig/routines/clear-stale-earn.md.',
          last: { who: 'Rig', text: 'Next run Monday 9:00', ago: 'Mon' },
          steps: [
            { text: 'Saved .rig/routines/clear-stale-earn.md' },
            { text: 'Next run Monday 9:00', ago: 'Mon' },
          ],
          origin: 'mock',
        },
      });
      fly(from, id, { kind: 'session', name: 'Routine', queued: true }, () => {
        const msg = `m${++nextId.current}`;
        dispatch({ type: 'message', message: { id: msg, who: 'rig', blocks: null } });
        later(250, () =>
          dispatch({
            type: 'message-blocks',
            id: msg,
            blocks: [
              {
                kind: 'text',
                runs: [
                  {
                    kind: 'text',
                    text: `Saved. It sits in the rail under ${spacesRef.current[0]?.name ?? 'your space'} with its next run.`,
                  },
                ],
              },
            ],
          })
        );
      });
    },
    [fly, later]
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      if (homeRuns) {
        sendToHomeClaude(text);
        return;
      }
      dispatch({ type: 'message', message: { id: `m${++nextId.current}`, who: 'me', text } });
      const id = `m${++nextId.current}`;
      dispatch({ type: 'message', message: { id, who: 'rig', blocks: null } });
      void Promise.all([
        orchestrator.respond(text, orchestratorContext),
        wait(600, reducedMotion),
      ]).then(([blocks]) => dispatch({ type: 'message-blocks', id, blocks }));
    },
    [orchestrator, orchestratorContext, reducedMotion, homeRuns]
  );

  const openInApp = useCallback(
    ({ space, session, sessionId }: { space: RailSpace; session?: RailSession; sessionId?: string }) => {
      if (!space.root) return;
      if (sessionId) onContinueSession(space.root, sessionId);
      else if (session?.id.startsWith('chat:'))
        onContinueSession(space.root, session.id.slice('chat:'.length));
      else onOpenPath(space.root, { kind: 'space' });
    },
    [onContinueSession, onOpenPath]
  );

  // Rig at work in the background: each connector's watch session checks on its schedule,
  // what it brings back is sorted into topics, and what needs you is promoted into the Feed.
  const runCheck = useCallback(
    (
      connector: SourceConnector,
      arrivalsOfCheck: Arrival[],
      schedule: (ms: number, fn: () => void) => void
    ) => {
      connectorsDispatch({ type: 'check-start', connector });
      schedule(TIMING.checkMs, () => {
        connectorsDispatch({
          type: 'check-done',
          connector,
          at: Date.now(),
          arrivals: arrivalsOfCheck,
        });
        if (arrivalsOfCheck.some((a) => a.toFeed) && !realFeedOn.current) {
          const item = ARRIVAL.item();
          if (!stateRef.current.feed.some((e) => e.item.id === item.id)) {
            dispatch({ type: 'add-item', item });
            toast(`New in your Feed: ${item.title}`);
          }
        }
        // Long enough for a new item's flight into the grid to land and pulse.
        schedule(4200, () => connectorsDispatch({ type: 'settle' }));
      });
    },
    [toast]
  );

  useEffect(() => {
    if (!arrivals || !demoOn) return;
    let cancelled = false;
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const schedule = (ms: number, fn: () => void) => {
      if (cancelled) return;
      const t = setTimeout(() => {
        pending.delete(t);
        if (!cancelled) fn();
      }, ms);
      pending.add(t);
    };
    CHECKS.forEach((check, i) =>
      schedule(TIMING.firstMs + i * TIMING.gapMs, () =>
        runCheck(check.connector, check.arrivals, schedule)
      )
    );
    // Then quiet checks keep going round, most of them with nothing new.
    let turn = 0;
    const quiet = () => {
      const list = connectorsRef.current.connectors;
      const next = list[turn++ % list.length];
      if (next && !next.checking) runCheck(next.connector, [], schedule);
      schedule(TIMING.quietGapMs, quiet);
    };
    schedule(TIMING.firstMs + CHECKS.length * TIMING.gapMs + TIMING.quietGapMs, quiet);
    return () => {
      cancelled = true;
      for (const t of pending) clearTimeout(t);
    };
  }, [arrivals, demoOn, runCheck]);

  const checkNow = useCallback(
    (connector: SourceConnector) => {
      if (connectorsRef.current.connectors.find((c) => c.connector === connector)?.checking) return;
      runCheck(connector, [], later);
    },
    [runCheck, later]
  );

  const promoteTopic = useCallback(
    (topicId: string) => {
      const topic = connectorsRef.current.topics.find((t) => t.id === topicId);
      if (!topic) return;
      connectorsDispatch({ type: 'topic-state', topic: topicId, state: 'feed' });
      dispatch({
        type: 'add-item',
        item: topicSuggestion({
          id: topic.id,
          name: topic.name,
          count: topic.count,
          connector: topic.items[0]?.connector ?? 'linear',
        }),
      });
      toast(`${topic.name} is in your Feed`);
    },
    [toast]
  );

  const api = useMemo<HomeApi>(
    () => ({
      state: shown,
      dispatch,
      feedStatus: realFeed,
      demo: demoOn,
      spaces,
      counts,
      firstName,
      reducedMotion,
      orchestrator,
      orchestratorContext,
      open,
      runItem,
      startSession,
      bringIn,
      addRoutine,
      send,
      homeRuns,
      toast,
      openInApp,
      connectors,
      connectorsDispatch,
      checkNow,
      promoteTopic,
      answerCard,
    }),
    // `counts` is derived from `shown.feed`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      shown,
      realFeed,
      demoOn,
      spaces,
      firstName,
      reducedMotion,
      orchestrator,
      orchestratorContext,
      open,
      runItem,
      startSession,
      bringIn,
      addRoutine,
      send,
      homeRuns,
      toast,
      openInApp,
      connectors,
      checkNow,
      promoteTopic,
      answerCard,
    ]
  );

  return (
    <HomeContext.Provider value={api}>
      <LandingsContext.Provider value={landings.current}>{children}</LandingsContext.Provider>
    </HomeContext.Provider>
  );
}

/** What to run when a flight lands, by flight id (read by the fly layer). */
export const LandingsContext = createContext<Map<string, () => void>>(new Map());
