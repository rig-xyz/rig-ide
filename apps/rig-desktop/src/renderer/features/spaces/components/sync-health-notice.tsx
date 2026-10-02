import { CloudOff, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { describeSyncHealth } from '@shared/rig/sync-health';
import { useSyncHealth } from '../use-sync-health';

/**
 * Says so when a space (or rig) isn't syncing on this computer — paused,
 * stopped, or failing to start — with the one button that fixes it. Never
 * silent: files that stopped syncing look exactly like files that are up
 * to date, so this is the only way anyone finds out.
 *
 * Sits above the Room's composer (same family as the connection banner).
 * A Home row says the same in its own status line (`spaces-card.tsx`).
 * Renders nothing while syncing is fine.
 */
export function SyncHealthNotice({
  path,
  className,
}: {
  /** The folder on this computer; null while it isn't known. */
  path: string | null;
  className?: string;
}) {
  const { health, start } = useSyncHealth(path);
  const notice = describeSyncHealth(health);
  if (!notice) return null;
  const starting = health?.state === 'starting';
  const title = notice.detail ? `${notice.text}\n${notice.detail}` : notice.text;
  const action = notice.action && (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void start();
      }}
      className="text-accent hover:opacity-80 focus-visible:outline-accent shrink-0 rounded-control text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      data-testid="sync-health-action"
    >
      {notice.action}
    </button>
  );
  const Icon = starting ? Loader2 : CloudOff;

  return (
    <div
      role="status"
      aria-live="polite"
      title={title}
      data-testid="sync-health-notice"
      data-state={health?.state}
      className={cn(
        'border-border-hairline bg-bg-1 text-text-secondary flex items-center gap-2 rounded-card border px-3 py-2 text-sm',
        className
      )}
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          notice.tone === 'bad' ? 'text-danger' : 'text-warning',
          starting && 'animate-spin'
        )}
        strokeWidth={1.5}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        {notice.text}
        {notice.detail && <span className="text-text-muted block truncate text-xs">{notice.detail}</span>}
      </span>
      {action}
    </div>
  );
}
