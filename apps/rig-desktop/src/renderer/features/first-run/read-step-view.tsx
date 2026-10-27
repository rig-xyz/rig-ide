import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import type { DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import type { OrchProgressEvent, RunProgress } from '@shared/rig/orch-progress';
import { StepFrame, type StepProps } from './first-run';
import { initialRead, readReducer, type ReadState } from './read/read-model';
import { ReadStep } from './read/read-step';

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
 * Step 5: the Read step (`./read/`) in the guide pane, and its progress on
 * the stage's field. Each lookup lights a few single tiles, scattered at
 * random in its tool's color, that settle after a moment into heavier grey:
 * the field fills up with what has been read. What it finds (done, not
 * yours, for you) keeps its own glyph. When the read is done, all of it
 * gathers into one green check: All caught up.
 */
export function ReadStepView({ env, onNext, setFieldLook, field }: StepProps) {
  // Mark the read as started, so a quit mid-read resumes here.
  const saved = useRef(false);
  useEffect(() => {
    if (saved.current) return;
    saved.current = true;
    env.saveProgress({ step: 'read', readStarted: true });
  }, [env]);

  // The same reading of the run as the guide pane, for the finish on the stage.
  const [read, dispatch] = useReducer(readReducer, initialRead);
  const spark = useRef(0);
  const live = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastAt = useRef(Date.now());
  const ended = read.ended?.ok ?? false;
  // The grey grid while it reads, every run (a replay starts again from a finished one).
  useEffect(() => {
    if (!ended) setFieldLook('plain');
  }, [ended, setFieldLook]);

  const light = useCallback(
    (color: string, ms = SPARK_MS, keep = true) => {
      const id = `spark:${spark.current++}`;
      const tile = field.current?.tile(id);
      if (!tile) return;
      tile.set(ACTIVITY[Math.floor(Math.random() * ACTIVITY.length)]!, color);
      live.current.set(
        id,
        setTimeout(() => {
          live.current.delete(id);
          // A read leaves its mark; a heartbeat (Claude thinking) leaves nothing.
          if (keep) tile.set(READ_TILE.state, READ_TILE.color);
          else tile.release();
        }, ms)
      );
    },
    [field]
  );

  useEffect(() => {
    const sparks = live.current;
    const timer = setInterval(() => {
      if (ended || Date.now() - lastAt.current < HEARTBEAT_MS) return;
      light('--accent', 1400, false);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      sparks.forEach(clearTimeout);
    };
  }, [ended, light]);

  // All caught up: drop the sparks, and gather the whole field into the check (`CaughtUp` says where).
  const gatherInto = useCallback(
    (check: DOMRect) => {
      live.current.forEach(clearTimeout);
      live.current.clear();
      const box = document.querySelector('.fr-stage')?.getBoundingClientRect();
      if (!box) return;
      field.current?.gather({
        x: (check.left + check.width / 2 - box.left) / box.width,
        y: (check.top + check.height / 2 - box.top) / box.height,
      });
    },
    [field]
  );

  const onProgress = useCallback(
    (event: OrchProgressEvent) => {
      dispatch(event);
      if (event.kind !== 'line') return;
      const { line } = event;
      const connector = line.connector ?? 'rig';
      if (line.status === 'running') {
        lastAt.current = Date.now();
        for (let i = 0; i < SPARKS_PER_LOOKUP; i++)
          light(CONNECTOR_COLOR[connector] ?? '--text-muted');
      }
      const tile = field.current?.tile(line.id);
      const next = tileFor(line);
      if (next) tile?.set(next.state, next.color);
      else tile?.release();
    },
    [field, light]
  );

  return (
    <StepFrame
      guide={
        <ReadStep source={env.readSource} onDone={onNext} onProgress={onProgress} doneInStage />
      }
      stage={<div>{ended && <CaughtUp read={read} onOpen={onNext} onPlaced={gatherInto} />}</div>}
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
        Rig checked {checked} {checked === 1 ? 'place' : 'places'} across {across}.
        {handled > 0 &&
          ` ${handled} ${handled === 1 ? 'was' : 'were'} already handled, so you can let ${handled === 1 ? 'it' : 'them'} go.`}
      </p>
      <p
        className="rig-caught-rise m-0 text-[15px] leading-relaxed text-text-primary"
        style={after(650)}
      >
        {forYou > 0
          ? `${forYou} ${forYou === 1 ? 'thing needs' : 'things need'} you. ${forYou === 1 ? "It's" : "They're"} on your Feed, ready to go.`
          : 'Nothing needs you right now. Rig keeps an eye out from here.'}
      </p>
      <div className="rig-caught-rise" style={after(900)}>
        <ActionButton variant="primary" icon={ArrowRight} onClick={onOpen}>
          {forYou > 0 ? 'See your Feed' : 'Open my Home'}
        </ActionButton>
      </div>
    </div>
  );
}
