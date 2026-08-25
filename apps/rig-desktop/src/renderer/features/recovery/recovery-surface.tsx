import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import type { RendererBootState } from './boot-state';
import { getRendererCorrelationId } from './renderer-error-reporting';

type RecoverySurfaceProps = {
  state: Exclude<RendererBootState, 'ready'>;
  detail?: string;
  onRetry: () => void;
  onContinue?: () => void;
  compact?: boolean;
};

function diagnosticText(state: RecoverySurfaceProps['state'], detail?: string): string {
  return [
    'Rig renderer diagnostics',
    `correlationId: ${getRendererCorrelationId()}`,
    `state: ${state}`,
    `detail: ${detail ? 'available' : 'none'}`,
  ].join('\n');
}

export function RecoverySurface({
  state,
  detail,
  onRetry,
  onContinue,
  compact = false,
}: RecoverySurfaceProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [exportState, setExportState] = useState<'idle' | 'saved' | 'failed'>('idle');
  const title = state === 'initializing' ? 'Starting Rig…' : 'Rig needs attention';
  const description =
    state === 'initializing'
      ? 'Loading settings and account status. This should only take a moment.'
      : state === 'degraded'
        ? 'The shell can continue, but account status is unavailable.'
        : 'Rig could not finish starting. Retry or reload the window to try again.';

  const copyDiagnostics = async () => {
    try {
      const attachment = await rpc.app.getDiagnosticLogAttachment();
      const text = `${diagnosticText(state, detail)}\n\n${attachment.content}`;
      const result = await rpc.app.clipboardWriteText(text);
      if (result?.success === false) throw new Error('Clipboard write failed');
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const exportDiagnostics = async () => {
    try {
      const attachment = await rpc.app.getDiagnosticLogAttachment();
      const result = await rpc.app.saveTextFile({
        title: 'Export Rig diagnostics',
        defaultPath: 'rig-diagnostics.txt',
        content: `${diagnosticText(state, detail)}\n\n${attachment.content}`,
      });
      if (result?.success === false) throw new Error('Diagnostics export failed');
      setExportState('saved');
    } catch {
      setExportState('failed');
    }
  };

  return (
    <main
      className={`flex w-full items-center justify-center bg-bg-0 p-6 text-text-primary ${compact ? 'h-full min-h-0' : 'min-h-screen'}`}
    >
      <section className="w-full max-w-xl rounded-lg border border-border-hairline bg-bg-1 p-6 shadow-sm">
        <p className="mb-2 text-xs font-medium tracking-wider text-text-muted uppercase">
          Rig recovery
        </p>
        <h1 className="mb-2 text-xl font-semibold">{title}</h1>
        <p className="mb-4 text-sm text-text-secondary">{description}</p>
        {detail && state !== 'initializing' && (
          <p className="mb-4 rounded border border-border-hairline bg-bg-0 p-3 text-xs text-text-muted">
            {detail}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRetry}>{state === 'initializing' ? 'Retry' : 'Retry startup'}</Button>
          {state !== 'initializing' && (
            <Button onClick={() => window.location.reload()}>Reload Window</Button>
          )}
          {onContinue && (
            <Button variant="outline" onClick={onContinue}>
              Continue with defaults
            </Button>
          )}
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border-hairline pt-4">
          <Button variant="ghost" onClick={() => void copyDiagnostics()}>
            {copyState === 'copied' ? 'Diagnostics copied' : 'Copy diagnostics'}
          </Button>
          <Button variant="ghost" onClick={() => void exportDiagnostics()}>
            {exportState === 'saved' ? 'Diagnostics exported' : 'Export diagnostics'}
          </Button>
        </div>
        {(copyState === 'failed' || exportState === 'failed') && (
          <p className="mt-3 text-xs text-danger">
            Diagnostics could not be saved. Try again after reloading.
          </p>
        )}
        <p className="mt-4 text-xs text-text-muted">Reference: {getRendererCorrelationId()}</p>
      </section>
    </main>
  );
}
