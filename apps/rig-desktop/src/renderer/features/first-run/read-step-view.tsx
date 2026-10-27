import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import type { DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import { FIRST_RUN_CONNECTORS, type FirstRunConnector } from '@shared/rig/first-run';
import type { OrchProgressEvent, RunProgress } from '@shared/rig/orch-progress';
import { StepFrame, type StepProps } from './first-run';
import { captionOf, FieldCaptions, useFieldCaptions } from './read/field-captions';
import { initialRead, readReducer, type ReadState } from './read/read-model';
import { ReadStep, windowWords, type ReadFix } from './read/read-step';

/** Each connector's color on the field, from the app's own tokens. Unknown ones stay neutral. */
const CONNECTOR_COLOR: Record<string, string> = {
  slack: '--theme-3',
  linear: '--theme-7',
  github: '--text-secondary',
  gmail: '--theme-8',
  calendar: '--theme-5',
  notion: '--text-secondary',
  rig: '--accent',
};
const TOOL_NAME: Record<string, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gmail: 'Gmail',
  calendar: 'Calendar',
  notion: 'Notion',
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
/**
 * Once the first card is on the Feed, a beat, then on to it (First win): the read goes on in the
 * background, and Home's catch-up strip shows the rest of it and its All caught up.
 */
export const FIRST_CARD_BEAT_MS = 1400;

/**
 * Step 5: the Read step (`./read/`) in the guide pane, and its progress on
 * the stage's field. Each lookup lights a few single tiles, scattered at
 * random in its tool's color, one of them captioned with what it reads, that
 * settle after a moment into heavier grey: the field fills up with what has
 * been read. What it finds (done, not yours, for you) keeps its own glyph.
 * As soon as the first card is ready it moves on to it, while the read goes
 * on; a read that ends with no card gathers into one green check: All
 * caught up.
 */
export function ReadStepView({ env, onNext, setFieldLook, field }: StepProps) {
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
        const known = (FIRST_RUN_CONNECTORS as readonly string[]).includes(connector);
        env.openConnect((known ? connector : 'slack') as FirstRunConnector);
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

  // The same reading of the run as the guide pane, for the finish on the stage.
  const [read, dispatch] = useReducer(readReducer, initialRead);
  const spark = useRef(0);
  const live = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastAt = useRef(Date.now());
  const ended = read.ended?.ok ?? false;
  const firstCard = read.cards.length > 0;
  // All caught up on the stage only for a read that ended with nothing to show; with a card it moves on.
  const caughtUp = ended && !firstCard;
  const captions = useFieldCaptions();

  // The first card: a beat, then on to it. Leaving doesn't stop the read (main runs it).
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (!firstCard) return;
    const timer = setTimeout(() => next.current(), FIRST_CARD_BEAT_MS);
    return () => clearTimeout(timer);
  }, [firstCard]);
  // The grey grid while it reads, every run (a replay starts again from a finished one).
  useEffect(() => {
    if (!caughtUp) setFieldLook('plain');
  }, [caughtUp, setFieldLook]);

  const light = useCallback(
    (color: string, ms = SPARK_MS, keep = true) => {
      const id = `spark:${spark.current++}`;
      const tile = field.current?.tile(id);
      if (!tile) return;
      tile.set(ACTIVITY[Math.floor(Math.random() * ACTIVITY.length)]!, color);
      const lit = tile;
      live.current.set(
        id,
        setTimeout(() => {
          live.current.delete(id);
          // A read leaves its mark; a heartbeat (Claude thinking) leaves nothing.
          if (keep) tile.set(READ_TILE.state, READ_TILE.color);
          else tile.release();
        }, ms)
      );
      return lit;
    },
    [field]
  );

  useEffect(() => {
    const sparks = live.current;
    const timer = setInterval(() => {
      if (caughtUp || Date.now() - lastAt.current < HEARTBEAT_MS) return;
      light('--accent', 1400, false);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      sparks.forEach(clearTimeout);
    };
  }, [caughtUp, light]);

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

  const onProgress = useCallback(
    (event: OrchProgressEvent) => {
      dispatch(event);
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
      const tile = field.current?.tile(line.id);
      const next = tileFor(line);
      if (next) tile?.set(next.state, next.color);
      else tile?.release();
    },
    [field, light, captions]
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

  return (
    <StepFrame
      guide={
        <ReadStep
          key={attempt}
          source={env.readSource}
          onDone={onNext}
          onProgress={onProgress}
          doneInStage
          onFix={fix}
          fixing={waitingFor !== null}
          connectorsHome={env.agentInfo.route.connectorsHome}
        />
      }
      stage={
        <div>
          {!caughtUp && <FieldCaptions captions={captions.captions} />}
          {caughtUp && <CaughtUp read={read} onOpen={onNext} onPlaced={gatherInto} />}
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
