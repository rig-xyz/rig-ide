import { ChevronRight, FileText, Loader2, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { PermissionPrompt } from '@renderer/features/chat/permission-prompt';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { cn } from '@renderer/lib/utils';
import { agentLogoId, BrandLogo } from '../logos';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import { SessionTrace } from './session-trace';
import type { RoomMember, SessionEvent, SessionRunMeta } from '../types';

/**
 * Spaces (lane 2): the session card — a person's agent, working in the
 * open. Header: agent logo with the owner's avatar as a badge, agent name,
 * model, elapsed, and Stop while running. Body: the current step (spinner +
 * target) while running, output file rows with +/- stats, and the final
 * answer once there is one. Footer: an "N steps" toggle that expands the
 * full step log in place.
 *
 * Pure presentation over `projectSessionCard(events)` — no polling, no
 * timers beyond the elapsed-time ticker, which is display-only and never
 * mutates the projection.
 */

const AGENT_NAME: Record<'claude' | 'codex', string> = { claude: 'Claude', codex: 'Codex' };

function formatElapsed(startedAt: string, endedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function stepVerb(kind: string | undefined, status: string | undefined): string {
  if (status === 'pending') return 'Preparing';
  switch (kind) {
    case 'read':
      return 'Reading';
    case 'edit':
      return 'Writing';
    case 'search':
      return 'Searching';
    case 'execute':
      return 'Running';
    default:
      return 'Working on';
  }
}

export function SessionCard({
  meta,
  events,
  owner,
  onStop,
  onResolvePermission,
}: {
  meta: SessionRunMeta;
  events: SessionEvent[];
  owner: RoomMember | undefined;
  onStop?: () => void;
  /** Only passed for the viewer's OWN agent's run: approvals belong to the owner, on their own card. */
  onResolvePermission?: (requestId: string, optionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<{ requestId: string; optionId: string } | null>(null);
  const card = useMemo(() => projectSessionCard(events), [events]);
  const status = effectiveRunStatus(meta.status, card);
  const running = status === 'running';
  // Approvals belong to the agent's owner: their card gets the prompt,
  // everyone else at most one muted line while it's pending, nothing once
  // it's decided. The full detail stays in the step log.
  const pendingPermission = card.permissions.pending[0] ?? null;

  return (
    <div
      // Opening the trace widens the card: the chat transcript needs room.
      className={cn(
        'border-border-hairline bg-bg-1 flex flex-col gap-2.5 rounded-card border p-3 transition-[max-width]',
        open ? 'max-w-[680px]' : 'max-w-[440px]'
      )}
      data-testid="session-card"
      data-status={status}
    >
      {/* header */}
      <div className="flex items-center gap-2.5">
        <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
          <BrandLogo id={agentLogoId(meta.agent)} size={18} />
          <IdentityAvatar
            name={owner?.name ?? meta.owner}
            avatarUrl={null}
            sizeClassName="absolute -right-1 -bottom-1 size-3.5"
            textClassName="text-2xs"
            className="ring-bg-1 ring-1"
          />
        </span>
        <b className="text-sm font-medium text-text-primary">{AGENT_NAME[meta.agent]}</b>
        {meta.model && meta.model !== 'unknown' && (
          <span className="font-mono text-xs text-text-muted">{meta.model}</span>
        )}
        <span className="ml-auto font-mono text-xs text-text-muted">
          {formatElapsed(meta.startedAt, meta.endedAt)}
        </span>
        {running && onStop && (
          <button
            type="button"
            onClick={onStop}
            className="border-border-hairline hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-control border px-2 text-xs text-text-primary transition-colors"
          >
            <Square className="size-2.5" strokeWidth={1.5} fill="currentColor" />
            Stop
          </button>
        )}
      </div>

      {/* body */}
      <div className="flex flex-col gap-1 pl-[29px]">
        {running && card.currentStep && (
          <div className="flex h-6.5 items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-text-muted" strokeWidth={1.5} />
            <span className="active-shimmer-muted shrink-0">
              {stepVerb(card.currentStep.kind, card.steps.at(-1)?.status)}
            </span>
            <span className="min-w-0 truncate font-mono text-xs text-text-primary">
              {card.currentStep.title ?? card.currentStep.toolCallId}
            </span>
          </div>
        )}
        {pendingPermission &&
          (onResolvePermission ? (
            <PermissionPrompt
              className="py-1"
              title={pendingPermission.title}
              options={pendingPermission.options}
              resolvingOptionId={
                resolving?.requestId === pendingPermission.requestId ? resolving.optionId : null
              }
              onResolve={(optionId) => {
                setResolving({ requestId: pendingPermission.requestId, optionId });
                onResolvePermission(pendingPermission.requestId, optionId);
              }}
            />
          ) : (
            <div
              data-testid="permission-waiting-line"
              className="flex h-6 items-center text-xs text-text-muted"
            >
              <span className="min-w-0 truncate">
                Waiting on {owner?.name ?? meta.owner}'s approval
              </span>
            </div>
          ))}
        {card.outputs.map((output) => (
          <div
            key={output.path}
            className="-ml-2 flex h-7.5 items-center gap-2 rounded-control px-2 font-mono text-xs text-text-primary"
          >
            <FileText className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
            <span className="min-w-0 truncate">{output.path.split('/').pop()}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-text-muted">
              <span className="text-success">+{output.adds}</span>
              {output.dels > 0 && <span className="text-danger">−{output.dels}</span>}
              {output.approximate && <span title="Approximate — the fixture truncated this diff">~</span>}
            </span>
          </div>
        ))}
        {card.finalAnswer && (
          <SafeMarkdown
            content={card.finalAnswer}
            className="pt-1 text-sm leading-relaxed text-text-primary"
          />
        )}
      </div>

      {/* footer */}
      {card.steps.length > 0 && (
        <div className="border-border-hairline -mx-3 -mb-3 border-t px-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex h-8.5 items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', open && 'rotate-90')}
              strokeWidth={1.5}
            />
            {card.steps.length} {card.steps.length === 1 ? 'step' : 'steps'}
          </button>
          {open && (
            <div className="-mx-3 border-border-hairline border-t" data-testid="session-steps-log">
              <SessionTrace runId={meta.id} events={events} running={running} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
