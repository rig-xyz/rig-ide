import { prepareFields } from '@emdash/shared/logger';

const correlationId = crypto.randomUUID();

export type RendererFailureKind = 'render-error' | 'unhandled-error' | 'unhandled-rejection';

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 80) : 'UnknownError';
}

function emitFailure(kind: RendererFailureKind, error: unknown): void {
  const payload = {
    kind,
    correlationId,
    errorName: errorName(error),
    // Keep diagnostics content-free: no exception message, stack, prompt, or
    // file contents cross the renderer boundary. The main logger still adds
    // its normal redaction and payload-size guardrails.
    message: 'Renderer failure reported',
  };
  try {
    console.error(payload);
    window.electronAPI?.eventSend('emdash:renderer-log', {
      level: 'error',
      source: 'renderer',
      correlationId,
      input: [prepareFields(payload)],
    });
  } catch {
    // Diagnostics must never become another renderer failure.
  }
}

export function reportRendererFailure(kind: RendererFailureKind, error: unknown): void {
  emitFailure(kind, error);
}

export function getRendererCorrelationId(): string {
  return correlationId;
}

export function installRendererErrorReporting(): () => void {
  const onError = (event: ErrorEvent) =>
    emitFailure('unhandled-error', event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) =>
    emitFailure('unhandled-rejection', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
