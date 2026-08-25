export type BootDependencyState = 'pending' | 'ready' | 'failed';
export type RendererBootState = 'initializing' | 'ready' | 'degraded' | 'failed';

export function deriveRendererBootState(input: {
  settings: BootDependencyState;
  auth: BootDependencyState;
  override?: boolean;
  timedOut?: boolean;
}): RendererBootState {
  if (input.override) return 'ready';
  if (input.timedOut && (input.settings === 'pending' || input.auth === 'pending')) {
    return 'failed';
  }
  if (input.settings === 'failed') return 'failed';
  if (input.settings === 'pending' || input.auth === 'pending') return 'initializing';
  if (input.auth === 'failed') return 'degraded';
  return 'ready';
}
