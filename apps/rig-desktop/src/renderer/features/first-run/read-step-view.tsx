import { useCallback, useEffect, useRef } from 'react';
import type { DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import type { OrchProgressEvent, RunProgress } from '@shared/rig/orch-progress';
import { StepFrame, type StepProps } from './first-run';
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

/** Where each connector's reading gathers on the field, as fractions of its size. */
const HOME: Record<string, { x: number; y: number }> = {
  slack: { x: 0.3, y: 0.3 },
  linear: { x: 0.7, y: 0.26 },
  github: { x: 0.72, y: 0.68 },
  gmail: { x: 0.28, y: 0.72 },
  calendar: { x: 0.5, y: 0.82 },
  notion: { x: 0.5, y: 0.16 },
  rig: { x: 0.5, y: 0.5 },
};

/** While the run is quiet between lookups, a small patch wakes this often, so the field never stands still. */
const HEARTBEAT_MS = 1100;

/** What a line's tile shows: reading while it runs, then the glyph for what it found. */
function tileFor(line: RunProgress): { state: DotMatrixState; color: string } {
  const color = (line.connector && CONNECTOR_COLOR[line.connector]) || '--text-muted';
  switch (line.status) {
    case 'running':
      return { state: line.connector === 'rig' ? 'thinking' : 'reading', color };
    case 'done':
      return { state: 'done', color: '--text-muted' };
    case 'failed':
      return { state: 'failed', color: '--text-muted' };
    case 'handled':
      return { state: 'done', color: '--status-ok' };
    case 'not_yours':
      return { state: 'queued', color: '--text-muted' };
    case 'for_you':
      return { state: 'waiting', color: '--accent' };
  }
}

const jitter = (v: number, by: number) =>
  Math.min(0.92, Math.max(0.08, v + (Math.random() - 0.5) * by));

/**
 * Step 5: the Read step (`./read/`) in the guide pane, and its progress on
 * the stage's field. The field starts quiet; each lookup wakes a patch near
 * its connector's corner in its color (so the field fills with the person's
 * work as it reads), claims one tile that settles to what it found, and a
 * small heartbeat keeps it moving while Claude decides what to check next.
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

  const last = useRef<{ connector: string; at: number }>({ connector: 'rig', at: Date.now() });
  const ended = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (ended.current || Date.now() - last.current.at < HEARTBEAT_MS) return;
      const home = HOME[last.current.connector] ?? HOME.rig!;
      field.current?.wake(
        { x: jitter(home.x, 0.3), y: jitter(home.y, 0.3), radius: 0.035 },
        '--accent'
      );
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [field]);

  const onProgress = useCallback(
    (event: OrchProgressEvent) => {
      if (event.kind === 'end') ended.current = true;
      if (event.kind === 'card') field.current?.wake({ x: 0.5, y: 0.5, radius: 0.09 }, '--accent');
      if (event.kind !== 'line') return;
      const { line } = event;
      const connector = line.connector ?? 'rig';
      if (line.status === 'running') {
        const home = HOME[connector] ?? HOME.rig!;
        field.current?.wake(
          { x: jitter(home.x, 0.16), y: jitter(home.y, 0.16), radius: 0.06 },
          CONNECTOR_COLOR[connector] ?? '--text-muted'
        );
        last.current = { connector, at: Date.now() };
      }
      const { state, color } = tileFor(line);
      field.current?.tile(line.id).set(state, color);
    },
    [field]
  );

  return (
    <StepFrame
      guide={<ReadStep source={env.readSource} onDone={onNext} onProgress={onProgress} />}
      stage={null}
    />
  );
}
