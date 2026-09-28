import { CloudOff, Loader2, WifiOff } from 'lucide-react';
import { CONNECTION_BANNER_TEXT, type HomeConnection } from '@renderer/features/home/home-connection';
import { cn } from '@renderer/lib/utils';

/**
 * The one connection notice, shared by Home and a space: what's wrong in
 * plain words, that what's shown comes from this computer, and a way to try
 * again. "Slow" is a quieter hint with no action — it isn't a failure yet.
 */
export function ConnectionBanner({
  connection,
  retrying,
  onTryAgain,
  className,
}: {
  connection: Exclude<HomeConnection, 'online'>;
  retrying: boolean;
  onTryAgain: () => void;
  className?: string;
}) {
  const Icon = connection === 'offline' ? WifiOff : connection === 'unreachable' ? CloudOff : Loader2;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
      data-variant={connection}
      className={cn(
        'border-border-hairline bg-bg-1 text-text-secondary flex items-center gap-2 rounded-card border px-3 py-2 text-sm',
        connection === 'slow' && 'text-text-muted border-transparent bg-transparent px-1 py-0.5 text-xs',
        className
      )}
    >
      <Icon
        className={cn('size-3.5 shrink-0 text-text-muted', connection === 'slow' && 'animate-spin')}
        strokeWidth={1.5}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{CONNECTION_BANNER_TEXT[connection]}</span>
      {connection !== 'slow' &&
        (retrying ? (
          <span className="text-text-muted flex shrink-0 items-center gap-1.5 text-xs" data-testid="connection-reconnecting">
            <Loader2 className="size-3 animate-spin" strokeWidth={1.5} aria-hidden />
            Reconnecting…
          </span>
        ) : (
          <button
            type="button"
            onClick={onTryAgain}
            className="text-accent hover:opacity-80 focus-visible:outline-accent shrink-0 rounded-control text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Try again
          </button>
        ))}
    </div>
  );
}
