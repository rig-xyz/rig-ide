import { Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import type { ProjectServerNotice } from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';

/**
 * The servers this space's own `.mcp.json` declares that you haven't allowed
 * on this computer. Your Claude in this space doesn't get them until you do:
 * rig never approves one for you. Allow records it for this folder only, on
 * this computer, and your next run there loads it. Sits above the Room's
 * composer, beside the sync notice; renders nothing when there's nothing to
 * allow.
 */
export function ProjectServersNotice({ bindingId, className }: { bindingId: string; className?: string }) {
  const [pending, setPending] = useState<ProjectServerNotice[]>([]);
  const [hidden, setHidden] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void connectorsApi
      .projectServers(bindingId)
      .then((servers) => {
        if (!cancelled) setPending(servers);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bindingId]);

  if (hidden || pending.length === 0) return null;

  const allow = async (name: string) => {
    setFailed(null);
    const ok = await connectorsApi.allowProjectServer(bindingId, name).catch(() => false);
    if (ok) setPending((list) => list.filter((s) => s.name !== name));
    else setFailed(name);
  };

  return (
    <div
      role="status"
      data-testid="project-servers-notice"
      className={cn(
        'border-border-hairline bg-bg-1 text-text-secondary flex flex-col gap-1.5 rounded-card border px-3 py-2 text-sm',
        className
      )}
    >
      {pending.map((server) => (
        <div key={server.name} className="flex items-center gap-2" title={server.url ?? 'Runs a command on this computer'}>
          <Plug className="text-warning size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          <span className="min-w-0 flex-1">
            This space uses {server.name}
            <span className="text-text-muted block truncate text-xs">
              {failed === server.name
                ? "Couldn't allow it. Try again."
                : 'Your agent here can’t use it until you allow it on this computer.'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => void allow(server.name)}
            className="text-accent hover:opacity-80 focus-visible:outline-accent shrink-0 rounded-control text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
            data-testid="project-server-allow"
          >
            Allow
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setHidden(true)}
        className="text-text-muted hover:text-text-secondary self-end text-2xs"
        data-testid="project-servers-not-now"
      >
        Not now
      </button>
    </div>
  );
}
