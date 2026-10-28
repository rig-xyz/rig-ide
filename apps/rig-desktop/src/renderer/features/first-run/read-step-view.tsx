import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { arriveHome } from '@renderer/features/home-feed/arrival';
import type { SentResult } from '@renderer/features/home-feed/store';
import type { DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import type { OrchProgressEvent, RunProgress } from '@shared/rig/orch-progress';
import { StepFrame, type StepProps } from './first-run';
import { CardStack } from './first-win/card-stack';
import { captionOf, FieldCaptions, useFieldCaptions } from './read/field-captions';
import type { ReadState } from './read/read-model';
import {
  ReadHeader,
  readHint,
  ReadTicker,
  ReadTitle,
  useReadRun,
  windowWords,
  type ReadFix,
} from './read/read-step';

/** Each connector's color on the field, from the app's own tokens. Unknown ones stay neutral. */
const CONNECTOR_COLOR: Record<string, string> = {
  slack: '--theme-3',
  linear: '--theme-7',
  github: '--text-secondary',
  gmail: '--theme-8',
  calendar: '--theme-5',
  notion: '--text-secondary',
  granola: '--theme-4',
  rig: '--accent',
};
const TOOL_NAME: Record<string, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gmail: 'Gmail',
  calendar: 'Calendar',
  notion: 'Notion',
  granola: 'Granola',
};

/** A lookup lights this many single tiles, scattered, each for a moment. */
const SPARKS_PER_LOOKUP = 3;
const SPARK_MS = 2200;
/** While Claude decides what to check next, one tile lights this often, so the field never stands still. */
const HEARTBEAT_MS = 700;
/** What has been read stays on the field as a heavier grey tile, so the field fills up as Rig reads. */
const READ_TILE: { state: DotMatrixState; color: string } = {
  state: 'stopped',
  color: '--text-muted',
};

/** What a line's tile shows while it reads, then the glyph for what it found (null: let it go). */
function tileFor(line: RunProgress): { state: DotMatrixState; color: string } | null {
  const color = (line.connector && CONNECTOR_COLOR[line.connector]) || '--text-muted';
  switch (line.status) {
    case 'running':
      return { state: line.connector === 'rig' ? 'thinking' : 'reading', color };
    case 'done':
      return READ_TILE;
    case 'failed':
      return null;
    case 'handled':
      return { state: 'done', color: '--status-ok' };
    case 'not_yours':
      return { state: 'queued', color: '--text-muted' };
    case 'for_you':
      return { state: 'waiting', color: '--accent' };
  }
}

const ACTIVITY: DotMatrixState[] = ['reading', 'searching', 'thinking'];
/** A thought's caption stays this long on its tile. */
const THOUGHT_MS = 2600;
/** Once the read ends with a card up, its tiles go back to the grid over this long, at random. */
const SETTLE_MS = 2200;

/**
 * Step 5, the first run's one stage: Rig reading the person's tools, and
 * the first cards it finds. The guide pane keeps what it's doing: the status
 * line, the counters, the ticker and the actions (`ReadHeader`,
 * `ReadTicker`); its title, with its matrix, stands at the top of the stage
 * over the field (`ReadTitle`). Each lookup lights a few single tiles, scattered at
 * random in its tool's color, one captioned with what it reads, and they
 * settle after a moment into heavier grey: the field fills up with what has
 * been read. Between lookups, Claude's own thinking captions a tile. As soon
 * as a card is ready it rises over the field, which keeps reading behind
 * it: the person can act on it, cycle the others, or watch. When the read
 * ends the sparks stop and the field settles into a slow breath. A read
 * that ends with no card gathers into one green check: All caught up.
 */
export function ReadStepView(props: StepProps) {
  const { env } = props;
  // Set up is done by now: make the private Home space while Rig reads, so the first Send has a place to run.
  const ensureHome = useRef(env.ensureHome);
  useEffect(() => ensureHome.current(), []);
  // Mark the read as started, so a quit mid-read resumes here.
  const saved = useRef(false);
  useEffect(() => {
    if (saved.current) return;
    saved.current = true;
    env.saveProgress({ step: 'read', readStarted: true });
  }, [env]);

  // A stopped read starts again after its fix: each try is a new run, from a fresh Read.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // A fix that takes a sign-in waits for it to finish, then reads again.
  const [waitingFor, setWaitingFor] = useState<'rig' | 'agent' | null>(null);
  const sawSignIn = useRef(false);
  useEffect(() => {
    if (waitingFor === 'rig') {
      if (env.rigSignIn.phase !== 'idle') sawSignIn.current = true;
      else if (sawSignIn.current) {
        sawSignIn.current = false;
        setWaitingFor(null);
        if (!env.rigSignIn.error) {
          env.recheck();
          retry();
        }
      }
    } else if (waitingFor === 'agent') {
      if (env.agent.kind === 'signingIn') sawSignIn.current = true;
      else if (sawSignIn.current) {
        sawSignIn.current = false;
        setWaitingFor(null);
        if (env.agent.kind === 'ready') retry();
      }
    }
  }, [waitingFor, env, retry]);
  const fix = useCallback(
    ({ problem, connector }: ReadFix) => {
      if (problem === 'connector_auth' && connector) {
        env.openConnect(connector);
      } else if (problem === 'rig_signed_out') {
        setWaitingFor('rig');
        env.startRigSignIn();
      } else if (problem === 'agent_signed_out') {
        setWaitingFor('agent');
        env.signInAgent();
      } else retry();
    },
    [env, retry]
  );

  // Read starts only on a Rig sign-in the relay took just now (the shell sends any other to Set up).
  if (env.rig.kind !== 'signedIn') {
    return (
      <StepFrame
        guide={
          <p className="m-0 text-[13px] text-text-secondary" data-testid="read-checking">
            Checking your Rig sign-in…
          </p>
        }
        stage={<div />}
      />
    );
  }
  return <ReadStage key={attempt} {...props} onFix={fix} fixing={waitingFor !== null} />;
}

function ReadStage({
  env,
  onNext,
  setFieldLook,
  field,
  openSession,
  onFix,
  fixing,
}: StepProps & { onFix: (fix: ReadFix) => void; fixing: boolean }) {
  const spark = useRef(0);
  const live = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Every tile the read lit, to let them go when it settles. */
  const claimed = useRef(new Set<string>());
  const lastAt = useRef(Date.now());
  const captions = useFieldCaptions();
  const endedRef = useRef(false);

  const light = useCallback(
    (color: string, ms = SPARK_MS, keep = true) => {
      if (endedRef.current) return;
      const id = `spark:${spark.current++}`;
      const tile = field.current?.tile(id);
      if (!tile) return;
      claimed.current.add(id);
      tile.set(ACTIVITY[Math.floor(Math.random() * ACTIVITY.length)]!, color);
      live.current.set(
        id,
        setTimeout(() => {
          live.current.delete(id);
          // A read leaves its mark; a heartbeat (Claude thinking) leaves nothing.
          if (keep) tile.set(READ_TILE.state, READ_TILE.color);
          else {
            tile.release();
            claimed.current.delete(id);
          }
        }, ms)
      );
      return tile;
    },
    [field]
  );

  const onProgress = useCallback(
    (event: OrchProgressEvent) => {
      if (event.kind === 'thought') {
        // Claude thinking between lookups: a tile in the accent says what about.
        lastAt.current = Date.now();
        const at = light('--accent', THOUGHT_MS, false)?.at();
        if (at) captions.show({ id: `thought:${event.t}`, at, connector: 'rig', text: captionOf(event.text) }, THOUGHT_MS);
        return;
      }
      if (event.kind !== 'line') return;
      const { line } = event;
      const connector = line.connector ?? 'rig';
      if (line.status === 'running') {
        lastAt.current = Date.now();
        for (let i = 0; i < SPARKS_PER_LOOKUP; i++) {
          const lit = light(CONNECTOR_COLOR[connector] ?? '--text-muted');
          // One spark per lookup in the person's tools says what it reads; Rig's own lookups stay quiet.
          if (i > 0 || connector === 'rig') continue;
          const at = lit?.at();
          if (at) captions.show({ id: line.id, at, connector, text: captionOf(line.label) }, SPARK_MS);
        }
        captions.rename(line.id, captionOf(line.label));
      }
      if (endedRef.current) return;
      const tile = field.current?.tile(line.id);
      const next = tileFor(line);
      if (next) {
        claimed.current.add(line.id);
        tile?.set(next.state, next.color);
      } else tile?.release();
    },
    [field, light, captions]
  );

  const run = useReadRun(env.readSource, onProgress);
  const { state } = run;
  const ended = state.ended?.ok ?? false;
  const stopped = state.ended !== null && !state.ended.ok;
  const hasCards = state.cards.length > 0;
  // All caught up on the stage only for a read that ended with nothing to show.
  const caughtUp = ended && !hasCards;
  // With a card up, the read ending is quiet: the field settles and breathes.
  const settled = ended && hasCards;
  endedRef.current = state.ended !== null;

  // The grey grid while it reads, every run (a replay starts again from a finished one).
  useEffect(() => {
    if (!state.ended) setFieldLook('plain');
  }, [state.ended, setFieldLook]);

  // While Claude decides what to check next, a tile lights now and then, so the field never stands still.
  useEffect(() => {
    if (state.ended) return;
    const timer = setInterval(() => {
      if (Date.now() - lastAt.current < HEARTBEAT_MS) return;
      light('--accent', 1400, false);
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [state.ended, light]);
  useEffect(() => {
    const sparks = live.current;
    return () => sparks.forEach(clearTimeout);
  }, []);

  // The read ended with a card up: the sparks stop, the tiles go back to the grid, and the field breathes.
  const clearCaptions = captions.clear;
  useEffect(() => {
    if (!settled) return;
    live.current.forEach(clearTimeout);
    live.current.clear();
    clearCaptions();
    const timers = [...claimed.current].map((id) =>
      setTimeout(() => field.current?.tile(id).release(), Math.random() * SETTLE_MS)
    );
    claimed.current.clear();
    setFieldLook('calm');
    return () => timers.forEach(clearTimeout);
  }, [settled, field, setFieldLook, clearCaptions]);

  // All caught up: drop the sparks, and gather the whole field into the check (`CaughtUp` says where).
  const gatherInto = useCallback(
    (check: DOMRect) => {
      live.current.forEach(clearTimeout);
      live.current.clear();
      captions.clear();
      const box = document.querySelector('.fr-stage')?.getBoundingClientRect();
      if (!box) return;
      field.current?.gather({
        x: (check.left + check.width / 2 - box.left) / box.width,
        y: (check.top + check.height / 2 - box.top) / box.height,
      });
    },
    [field, captions]
  );

  // A sent or started card is the win: on to Home, the session it started landing in the rail.
  const won = useCallback(
    (result: SentResult) => {
      arriveHome(result.session ? { sessionId: result.session.sessionId } : {});
      onNext();
    },
    [onNext]
  );
  const trackStep = useRef(env.trackStep);
  trackStep.current = env.trackStep;

  return (
    <StepFrame
      guide={
        <section className="flex min-h-0 flex-1 flex-col gap-3.5" data-testid="read-step">
          <ReadHeader
            run={run}
            title={false}
            onFix={onFix}
            onLeave={stopped ? onNext : undefined}
            connectorsHome={env.agentInfo.route.connectorsHome}
            fixing={fixing}
          />
          <ReadTicker run={run} className={state.ended ? 'rig-read-settled' : undefined} />
          {!stopped && (
            <div className="flex flex-wrap items-center gap-2.5">
              <ActionButton
                variant={state.ended ? 'primary' : 'quiet'}
                icon={ArrowRight}
                onClick={onNext}
              >
                Open my Home
              </ActionButton>
              <span className="min-w-0 text-xs text-text-muted" data-testid="read-hint">
                {readHint(state)}
              </span>
            </div>
          )}
        </section>
      }
      stage={
        <div className="relative flex min-h-0 flex-col items-center gap-6 self-stretch justify-self-stretch pt-8" data-testid="read-stage">
          {!caughtUp && (
            <ReadTitle run={run} className="fr-read-head relative z-10 rounded-[16px] py-2.5 pr-5 pl-2.5" />
          )}
          <div className="relative z-10 flex min-h-0 w-full flex-1 items-start justify-center">
            {hasCards && (
              <CardStack
                firstWin={env.firstWin}
                landed={state.cards.length}
                onShown={() => trackStep.current('firstWin')}
                onWon={won}
                openSession={openSession}
              />
            )}
            {caughtUp && (
              <div className="self-center">
                <CaughtUp read={state} onOpen={onNext} onPlaced={gatherInto} />
              </div>
            )}
          </div>
          {!caughtUp && !settled && <FieldCaptions captions={captions.captions} />}
        </div>
      }
    />
  );
}

/** The check, as an LED matrix: 9×9 dots, the mark's own dots lighting along its stroke. */
const CHECK_PATH: [number, number][] = [
  [1, 4],
  [2, 5],
  [3, 6],
  [4, 5],
  [5, 4],
  [6, 3],
  [7, 2],
  [8, 1],
];
/** How long the field takes to gather before the check lights, and how long each dot of its stroke takes. */
const GATHER_MS = 1500;
const STROKE_DOT_MS = 55;

/**
 * The finish. The field breathes in and gathers into the middle (`gather`),
 * the gathered light becomes one large LED check that draws its stroke and
 * bounces with a soft green breath, and then the words rise in: what Rig
 * checked and let go, and what needs the person.
 */
function CaughtUp({
  read,
  onOpen,
  onPlaced,
}: {
  read: ReadState;
  onOpen: () => void;
  onPlaced: (check: DOMRect) => void;
}) {
  const mark = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(false);
  // Once, when it shows: the field gathers to where the check sits, then the check lights.
  const placed = useRef(onPlaced);
  useLayoutEffect(() => {
    if (mark.current) placed.current(mark.current.getBoundingClientRect());
    const timer = setTimeout(() => setLit(true), GATHER_MS - 150);
    return () => clearTimeout(timer);
  }, []);

  const tools = [
    ...new Set(read.lines.map((l) => l.connector).filter((c): c is string => !!c && c !== 'rig')),
  ].map((c) => TOOL_NAME[c] ?? c);
  const across =
    tools.length > 1
      ? `${tools.slice(0, -1).join(', ')} and ${tools.at(-1)}`
      : (tools[0] ?? 'your tools');
  const { read: checked, handled, forYou } = read.counts;
  const strokeEnd = GATHER_MS + CHECK_PATH.length * STROKE_DOT_MS;
  const after = (ms: number) => ({ animationDelay: `${(strokeEnd + ms) / 1000}s` });
  const onPath = new Map(CHECK_PATH.map(([x, y], i) => [`${x},${y}`, i]));

  return (
    <div
      className="flex max-w-[460px] flex-col items-center gap-5 text-center"
      data-testid="read-caught-up"
    >
      <div
        ref={mark}
        className={lit ? 'rig-check rig-check-lit' : 'rig-check'}
        style={{ ['--stroke-end' as string]: `${strokeEnd}ms` }}
        aria-hidden
      >
        <span className="rig-check-breath" />
        <span className="rig-check-grid">
          {Array.from({ length: 81 }, (_, i) => {
            const x = i % 9;
            const y = Math.floor(i / 9);
            const at = onPath.get(`${x},${y}`);
            return (
              <i
                key={i}
                className={at === undefined ? undefined : 'on'}
                style={at === undefined ? undefined : { animationDelay: `${at * STROKE_DOT_MS}ms` }}
              />
            );
          })}
        </span>
      </div>
      <h3
        className="rig-caught-rise m-0 font-display text-[40px] leading-[1.08] font-semibold tracking-[-0.025em] text-text-primary"
        style={after(250)}
      >
        All caught up.
      </h3>
      <p
        className="rig-caught-rise m-0 text-[15px] leading-relaxed text-text-secondary"
        style={after(450)}
      >
        Rig checked {checked} {checked === 1 ? 'place' : 'places'} across {across}
        {read.since ? ` ${windowWords(read)}` : ''}.
        {handled > 0 &&
          ` ${handled} ${handled === 1 ? 'was' : 'were'} already handled, so you can let ${handled === 1 ? 'it' : 'them'} go.`}
      </p>
      <p
        className="rig-caught-rise m-0 text-[15px] leading-relaxed text-text-primary"
        style={after(650)}
      >
        {forYou > 0
          ? `${forYou} ${read.since ? 'new ' : ''}${forYou === 1 ? 'card needs' : 'cards need'} you. ${forYou === 1 ? "It's" : "They're"} on your Feed, ready to go.`
          : read.since
            ? `Nothing new needs you ${windowWords(read)}. Rig keeps an eye out from here.`
            : 'Nothing needs you right now. Rig keeps an eye out from here.'}
      </p>
      <div className="rig-caught-rise" style={after(900)}>
        <ActionButton variant="primary" icon={ArrowRight} onClick={onOpen}>
          Open my Home
        </ActionButton>
      </div>
    </div>
  );
}
