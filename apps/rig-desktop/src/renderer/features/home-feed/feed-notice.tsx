import { useQueryClient } from '@tanstack/react-query';
import { LogIn, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { ActionButton } from './action-button';
import { RIG_FEED_KEY, type RealFeed } from './use-real-feed';

type Notice = Extract<RealFeed, { kind: 'signed-out' | 'unreachable' | 'unsupported' }>;

/**
 * Why the Feed has no cards to show, in its place: signed out (sign in),
 * can't reach Rig (try again), or a server without the Feed. Never the demo.
 */
export function FeedNotice({ status }: { status: Notice }) {
  const queryClient = useQueryClient();
  const retry = () => void queryClient.invalidateQueries({ queryKey: RIG_FEED_KEY });
  const { phase, error, signIn } = useRigSignIn(retry);
  const [retrying, setRetrying] = useState(false);

  if (status.kind === 'signed-out') {
    return (
      <Panel title="Sign in to see your Feed" data-feed-notice="signed-out">
        <p>Rig reads your work while you're away and puts what needs you here. {status.message}</p>
        {error && <p className="text-status-error">{error}</p>}
        <ActionButton variant="primary" size="sm" icon={LogIn} disabled={phase !== 'idle'} onClick={() => void signIn()}>
          {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </ActionButton>
      </Panel>
    );
  }
  if (status.kind === 'unsupported') {
    return (
      <Panel title="No Feed on this server" data-feed-notice="unsupported">
        <p>{status.message} Your spaces and sessions still work.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Can't reach Rig" data-feed-notice="unreachable">
      <p>{status.message} Your Feed comes back when Rig does.</p>
      <ActionButton
        size="sm"
        icon={RefreshCw}
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          await queryClient.refetchQueries({ queryKey: RIG_FEED_KEY });
          setRetrying(false);
        }}
      >
        Try again
      </ActionButton>
    </Panel>
  );
}

/** A Feed that's showing, while the relay is briefly out of reach: one quiet line above it. */
export function FeedStale() {
  const queryClient = useQueryClient();
  return (
    <p className="flex items-center gap-2 px-5 py-2 text-xs text-text-muted" data-feed-notice="stale">
      <span className="min-w-0 flex-1">Can't reach Rig right now; these may be out of date.</span>
      <button
        type="button"
        className="text-text-secondary hover:text-text-primary"
        onClick={() => void queryClient.refetchQueries({ queryKey: RIG_FEED_KEY })}
      >
        Try again
      </button>
    </p>
  );
}

function Panel({ title, children, ...rest }: { title: string; children: React.ReactNode; 'data-feed-notice': string }) {
  return (
    <div className="flex flex-col items-start gap-2.5 px-5 py-4 text-sm text-text-secondary" {...rest}>
      <h3 className="text-sm font-medium text-text-primary">{title}</h3>
      {children}
    </div>
  );
}
