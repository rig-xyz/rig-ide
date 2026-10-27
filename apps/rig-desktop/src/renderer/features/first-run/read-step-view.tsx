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
};

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

/**
 * Step 5: the Read step (`./read/`) in the guide pane, and its progress on
 * the stage's field: the field goes quiet, and each line claims one tile
 * that reads in its connector's color, then settles to what it found.
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

  const onProgress = useCallback(
    (event: OrchProgressEvent) => {
      if (event.kind !== 'line') return;
      const { state, color } = tileFor(event.line);
      field.current?.tile(event.line.id).set(state, color);
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
