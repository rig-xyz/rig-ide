import React from 'react';
import { RecoverySurface } from './recovery-surface';
import { reportRendererFailure } from './renderer-error-reporting';

type BoundaryProps = { children: React.ReactNode; scope?: string };
type BoundaryState = { error: Error | null };

export class RecoveryBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    reportRendererFailure('render-error', error);
  }

  retry = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <RecoverySurface
        state="failed"
        detail={`${this.props.scope ?? 'Renderer'} failed to render. Reload the window or retry.`}
        onRetry={this.retry}
        compact
      />
    );
  }
}
