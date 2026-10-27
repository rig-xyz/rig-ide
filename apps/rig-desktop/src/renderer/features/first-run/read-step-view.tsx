import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { DotMatrix, type DotMatrixState } from '@renderer/lib/ui/dot-matrix';
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
/** A lookup's own tile rests this long after it reads, then lets go: only what it found stays. */
const SETTLE_MS = 1400;

/** What a line's tile shows while it reads, then the glyph for what it found (null: let it go). */
function tileFor(line: RunProgress): { state: DotMatrixState; color: string } | null {
  const color = (line.connector && CONNECTOR_COLOR[line.connector]) || '--text-muted';
  switch (line.status) {
    case 'running':
      return { state: line.connector === 'rig' ? 'thinking' : 'reading', color };
    case 'done':
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
 * random in its tool's color, that fade after a moment; what it finds (done,
 * not yours, for you) keeps a tile. When the read is done, the field goes
 * still and fades nearly out, and the stage breathes out once: All caught up.
 */
export function ReadStepView({ env, onNext, setFieldLook, field }: StepProps) {
  useEffect(() => setFieldLook('plain'), [setFieldLook]);

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

  const light = useCallback(
    (color: string, ms = SPARK_MS) => {
      const id = `spark:${spark.current++}`;
      const tile = field.current?.tile(id);
      if (!tile) return;
      tile.set(ACTIVITY[Math.floor(Math.random() * ACTIVITY.length)]!, color);
      live.current.set(
        id,
        setTimeout(() => {
          live.current.delete(id);
          tile.release();
        }, ms)
      );
    },
    [field]
  );

  useEffect(() => {
    const sparks = live.current;
    const timer = setInterval(() => {
      if (ended || Date.now() - lastAt.current < HEARTBEAT_MS) return;
      light('--accent', 1400);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      sparks.forEach(clearTimeout);
    };
  }, [ended, light]);

  // All caught up: let every spark go, and let the field go still and fade nearly out.
  useEffect(() => {
    if (!ended) return;
    live.current.forEach((timer, id) => {
      clearTimeout(timer);
      field.current?.tile(id).release();
    });
    live.current.clear();
    field.current?.setMode('idle');
    setFieldLook('rest');
  }, [ended, field, setFieldLook]);

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
      else setTimeout(() => tile?.release(), SETTLE_MS);
    },
    [field, light]
  );

  return (
    <StepFrame
      guide={
        <ReadStep source={env.readSource} onDone={onNext} onProgress={onProgress} doneInStage />
      }
      stage={ended ? <CaughtUp read={read} onOpen={onNext} /> : null}
    />
  );
}

/** The finish: one slow breath of light, then what Rig did and what's left for the person. */
function CaughtUp({ read, onOpen }: { read: ReadState; onOpen: () => void }) {
  const tools = [
    ...new Set(read.lines.map((l) => l.connector).filter((c): c is string => !!c && c !== 'rig')),
  ].map((c) => TOOL_NAME[c] ?? c);
  const across =
    tools.length > 1
      ? `${tools.slice(0, -1).join(', ')} and ${tools.at(-1)}`
      : (tools[0] ?? 'your tools');
  const { read: checked, handled, forYou } = read.counts;
  return (
    <div
      className="flex max-w-[460px] flex-col items-center gap-5 text-center"
      data-testid="read-caught-up"
    >
      <div className="relative grid size-[88px] place-items-center">
        <span className="rig-caught-breath" aria-hidden />
        <span className="fr-glass rig-caught-rise grid size-[72px] place-items-center rounded-[22px]">
          <DotMatrix state="done" tone="ok" size="lg" />
        </span>
      </div>
      <h3
        className="rig-caught-rise m-0 font-display text-[40px] leading-[1.08] font-semibold tracking-[-0.025em] text-text-primary"
        style={{ animationDelay: '0.35s' }}
      >
        All caught up.
      </h3>
      <p
        className="rig-caught-rise m-0 text-[15px] leading-relaxed text-text-secondary"
        style={{ animationDelay: '0.6s' }}
      >
        Rig checked {checked} {checked === 1 ? 'place' : 'places'} across {across}.
        {handled > 0 &&
          ` ${handled} ${handled === 1 ? 'was' : 'were'} already handled, so you can let ${handled === 1 ? 'it' : 'them'} go.`}
      </p>
      <p
        className="rig-caught-rise m-0 text-[15px] leading-relaxed text-text-primary"
        style={{ animationDelay: '0.8s' }}
      >
        {forYou > 0
          ? `${forYou} ${forYou === 1 ? 'thing needs' : 'things need'} you. ${forYou === 1 ? "It's" : "They're"} on your Feed, ready to go.`
          : 'Nothing needs you right now. Rig keeps an eye out from here.'}
      </p>
      <div className="rig-caught-rise" style={{ animationDelay: '1.05s' }}>
        <ActionButton variant="primary" icon={ArrowRight} onClick={onOpen}>
          {forYou > 0 ? 'See your Feed' : 'Open my Home'}
        </ActionButton>
      </div>
    </div>
  );
}
