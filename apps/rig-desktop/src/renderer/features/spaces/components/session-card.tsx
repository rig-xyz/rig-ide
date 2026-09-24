import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileText,
  Globe,
  Pencil,
  Search,
  ShieldAlert,
  Square,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatClock } from '@renderer/lib/time-format';
import { Button } from '@renderer/lib/ui/button';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { Dialog, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { DotMatrix, type DotMatrixActivity } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import type {
  RoomMember,
  SessionCard as SessionCardData,
  SessionEvent,
  SessionOutput,
  SessionPermissionDecided,
  SessionPermissionPending,
  SessionRunMeta,
  SessionStep,
} from '../types';
import { AGENT_NAME, AgentAvatar } from './identity';
import { SessionTrace } from './session-trace';
import { ROW_GRID, RowTime } from './transcript-items';

/**
 * Spaces: one agent turn in the Room, drawn like any other speaker's row
 * rather than as a card: the agent's avatar, its name and model, then what
 * it is doing or what it did, and its answer as plain prose (people's
 * messages get bubbles, agents' don't).
 *
 * While running: a live line (the dot matrix plays what the agent is doing,
 * then the verb, the target and the elapsed time) over the steps so far.
 * Once done: one collapsed "Worked 28s · 3 steps" line that opens the step
 * list in place, with the full trace one click further in a side panel.
 * Files it changed are cards that open the file. Approvals belong to the
 * owner: they get the approval card, everyone else sees who it's waiting
 * on, and each decision stays in the step list as a record.
 *
 * Pure presentation over `projectSessionCard(events)`; the only timers are
 * the elapsed-time tick while running and the "Copied" confirmation.
 */

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function elapsedMs(startedAt: string, endedAt: string | null, now: number): number {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : end - start;
}

/** Re-renders once a second while `active`, for a live elapsed time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** What a step does, as a live verb, a past-tense verb and an icon. ACP tool kinds. */
const STEP_KINDS: Record<string, { live: string; past: string; icon: LucideIcon; matrix: DotMatrixActivity }> = {
  read: { live: 'Reading', past: 'Read', icon: FileText, matrix: 'reading' },
  fetch: { live: 'Fetching', past: 'Fetched', icon: Globe, matrix: 'reading' },
  edit: { live: 'Editing', past: 'Edited', icon: Pencil, matrix: 'editing' },
  delete: { live: 'Deleting', past: 'Deleted', icon: Pencil, matrix: 'editing' },
  move: { live: 'Moving', past: 'Moved', icon: Pencil, matrix: 'editing' },
  search: { live: 'Searching', past: 'Searched', icon: Search, matrix: 'searching' },
  execute: { live: 'Running', past: 'Ran', icon: SquareTerminal, matrix: 'running' },
  think: { live: 'Thinking', past: 'Thought', icon: Brain, matrix: 'thinking' },
};
const OTHER_STEP = { live: 'Working', past: 'Used', icon: Wrench, matrix: 'thinking' as DotMatrixActivity };
const stepKind = (kind: string | undefined) => (kind && STEP_KINDS[kind]) || OTHER_STEP;

/** "Allowed once" / "Always allowed" / "Denied", from the chosen option's kind. */
function decisionLabel(decided: SessionPermissionDecided): { text: string; allowed: boolean } {
  const kind = decided.optionKind ?? '';
  if (kind.startsWith('reject') || decided.outcome === 'rejected' || decided.outcome === 'denied') {
    return { text: kind === 'reject_always' ? 'Always denied' : 'Denied', allowed: false };
  }
  return { text: kind === 'allow_always' ? 'Always allowed' : 'Allowed once', allowed: true };
}

/** The approval buttons' own words, from each option's kind rather than the adapter's raw label. */
function optionLabel(option: { name: string; kind: string }): string {
  switch (option.kind) {
    case 'allow_once':
      return 'Allow once';
    case 'allow_always':
      return 'Always allow';
    case 'reject_once':
      return 'Deny';
    case 'reject_always':
      return 'Always deny';
    default:
      return option.name;
  }
}

function summaryLine(card: SessionCardData, elapsed: string): string {
  const parts = [elapsed ? `Worked ${elapsed}` : 'Worked'];
  if (card.steps.length > 0) parts.push(`${card.steps.length} ${card.steps.length === 1 ? 'step' : 'steps'}`);
  const reads = card.steps.filter((s) => s.kind === 'read').length;
  if (reads > 0) parts.push(`read ${reads} ${reads === 1 ? 'file' : 'files'}`);
  return parts.join(' · ');
}

function StepRow({
  step,
  decided,
  ownerName,
}: {
  step: SessionStep;
  decided: SessionPermissionDecided | undefined;
  ownerName: string;
}) {
  const kind = stepKind(step.kind);
  const failed = step.status === 'failed';
  const live = step.status === 'pending' || step.status === 'in_progress';
  const Icon = kind.icon;
  const decision = decided ? decisionLabel(decided) : null;
  return (
    <li className="flex min-w-0 flex-col" data-testid="session-step">
      <div className="flex h-6 min-w-0 items-center gap-2 text-xs text-text-secondary">
        {live ? (
          <DotMatrix state={kind.matrix} size="sm" className="mx-0.5" />
        ) : failed ? (
          <X className="size-3.5 shrink-0 text-danger" strokeWidth={1.5} />
        ) : (
          <Icon className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        )}
        <span className="min-w-0 truncate" title={step.title}>
          {step.title ?? kind.past}
        </span>
      </div>
      {decision && (
        <span className="ml-[22px] text-2xs text-text-muted" data-testid="session-decision">
          <span className={decision.allowed ? 'text-success' : 'text-danger'}>{decision.text}</span> by {ownerName}
          {decided?.decidedAt ? ` · ${formatClock(new Date(decided.decidedAt))}` : ''}
        </span>
      )}
    </li>
  );
}

function StepList({
  card,
  ownerName,
  limit,
}: {
  card: SessionCardData;
  ownerName: string;
  /** Show only the last N (while running); undefined shows all. */
  limit?: number;
}) {
  const steps = limit ? card.steps.slice(-limit) : card.steps;
  if (steps.length === 0) return null;
  return (
    <ul className="border-border-hairline ml-1.5 flex flex-col border-l pl-3" data-testid="session-steps">
      {steps.map((step) => (
        <StepRow
          key={step.toolCallId}
          step={step}
          decided={card.permissions.decided.find((d) => d.toolCallId === step.toolCallId)}
          ownerName={ownerName}
        />
      ))}
    </ul>
  );
}

/** The owner's approval ask: what it wants to do, the exact command or target, and the choices. */
function ApprovalCard({
  request,
  step,
  agentName,
  resolvingOptionId,
  onResolve,
}: {
  request: SessionPermissionPending;
  step: SessionStep | undefined;
  agentName: string;
  resolvingOptionId: string | null;
  onResolve: (optionId: string) => void;
}) {
  const kind = step?.kind;
  const [heading, why, Icon] =
    kind === 'execute'
      ? ['Run a command', `${agentName} wants to run this on your computer.`, SquareTerminal]
      : kind === 'edit' || kind === 'delete' || kind === 'move'
        ? ['Change a file', `${agentName} wants to change a file in this space.`, Pencil]
        : kind === 'fetch'
          ? ['Fetch a page', `${agentName} wants to fetch from the web.`, Globe]
          : ['Use a tool', `${agentName} wants your go-ahead first.`, ShieldAlert];
  // Deny quietest, "Always" in between, the one-off allow is the primary.
  const order = (k: string) => (k.startsWith('reject') ? 0 : k === 'allow_always' ? 1 : 2);
  const options = [...request.options].sort((a, b) => order(a.kind) - order(b.kind));
  return (
    <div
      className="border-border-hairline bg-bg-2 flex flex-col gap-3 rounded-card border p-3"
      data-testid="approval-card"
    >
      <div className="flex items-start gap-2.5">
        <span className="bg-bg-3 flex size-7 shrink-0 items-center justify-center rounded-control text-text-secondary">
          <Icon className="size-3.5" strokeWidth={1.5} />
        </span>
        <div className="flex min-w-0 flex-col">
          <b className="text-sm font-medium text-text-primary">{heading}</b>
          <span className="text-xs text-text-secondary">{why}</span>
        </div>
      </div>
      <code className="border-border-hairline bg-bg-1 rounded-control border px-2.5 py-1.5 font-mono text-xs break-all text-text-primary">
        {request.title}
      </code>
      <div className="flex flex-wrap justify-end gap-1.5">
        {options.map((option) => {
          const rank = order(option.kind);
          const resolving = resolvingOptionId === option.optionId;
          return (
            <Button
              key={option.optionId}
              size="sm"
              variant={rank === 0 ? 'ghost' : rank === 1 ? 'outline' : 'default'}
              disabled={resolvingOptionId !== null}
              onClick={() => onResolve(option.optionId)}
              title={option.name}
            >
              {resolving && <Check />}
              {optionLabel(option)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/** A file the agent changed, as something you can open. */
function FileCard({ output, onOpen }: { output: SessionOutput; onOpen?: () => void }) {
  const name = output.path.split('/').pop() ?? output.path;
  const dir = output.path.slice(0, Math.max(0, output.path.length - name.length - 1));
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="border-border-hairline bg-bg-1 enabled:hover:border-border-strong flex w-full max-w-[420px] items-center gap-2.5 rounded-card border px-2.5 py-2 text-left transition-colors"
      data-testid="session-output"
    >
      <span className="bg-bg-2 flex size-7 shrink-0 items-center justify-center rounded-control text-text-muted">
        <FileText className="size-3.5" strokeWidth={1.5} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-text-primary">{name}</span>
        {dir && <span className="truncate text-2xs text-text-muted">{dir}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-xs">
        <span className="text-success">+{output.adds}</span>
        {output.dels > 0 && <span className="text-danger">−{output.dels}</span>}
        {output.approximate && (
          <span className="text-text-muted" title="Approximate">
            ~
          </span>
        )}
      </span>
    </button>
  );
}

export function SessionCard({
  meta,
  events,
  owner,
  viewerIsOwner,
  continued = false,
  onStop,
  onResolvePermission,
  onOpenFile,
}: {
  meta: SessionRunMeta;
  events: SessionEvent[];
  owner: RoomMember | undefined;
  /** The viewer owns this agent: its name reads "yours" instead of "Sam's". Defaults to whether approvals were passed. */
  viewerIsOwner?: boolean;
  /** A follow-up turn from the same agent a moment later: no avatar or header. */
  continued?: boolean;
  onStop?: () => void;
  /** Only passed for the viewer's OWN agent's run: approvals belong to the owner. */
  onResolvePermission?: (requestId: string, optionId: string) => void;
  /** Opens a changed file (its path as the agent reported it). */
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [resolving, setResolving] = useState<{ requestId: string; optionId: string } | null>(null);
  const card = useMemo(() => projectSessionCard(events), [events]);
  const status = effectiveRunStatus(meta.status, card);
  const running = status === 'running';
  const now = useNow(running);
  const elapsed = formatElapsed(elapsedMs(meta.startedAt, meta.endedAt, now));
  const model = card.model ?? (meta.model && meta.model !== 'unknown' ? meta.model : null);
  const agentName = AGENT_NAME[meta.agent];
  const ownerName = owner?.name ?? meta.owner;
  const mine = viewerIsOwner ?? !!onResolvePermission;
  const pending = card.permissions.pending[0] ?? null;
  const currentKind = stepKind(card.currentStep?.kind);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const liveLabel = pending
    ? onResolvePermission
      ? 'Waiting for your approval'
      : `Waiting on ${ownerName}'s approval`
    : card.currentStep
      ? currentKind.live
      : events.length > 0
        ? 'Thinking'
        : 'Starting';
  const liveMatrix: DotMatrixActivity = pending
    ? 'waiting'
    : card.currentStep
      ? currentKind.matrix
      : events.length > 0
        ? 'thinking'
        : 'starting';

  return (
    <div className={cn(ROW_GRID, 'group relative py-1')} data-testid="session-card" data-status={status}>
      {continued ? (
        <RowTime message={{ createdAt: meta.startedAt }} short className="self-start justify-self-center pt-1" />
      ) : (
        <AgentAvatar agent={meta.agent} owner={owner} className="mt-0.5" />
      )}

      <div className="flex min-w-0 flex-col gap-1.5">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <b className="text-sm font-medium text-text-primary">{agentName}</b>
            <span className="text-xs text-text-muted">
              {[model, mine ? 'yours' : `${ownerName}'s`].filter(Boolean).join(' · ')}
            </span>
            <RowTime message={{ createdAt: meta.startedAt }} />
          </div>
        )}

        {running ? (
          <>
            <div
              className="flex h-6 min-w-0 items-center gap-2 text-sm text-text-secondary"
              data-testid="session-live-line"
            >
              <DotMatrix state={liveMatrix} />
              <span className="active-shimmer-muted shrink-0">{liveLabel}</span>
              {card.currentStep && !pending && (
                <span className="min-w-0 truncate text-xs text-text-primary">
                  {card.currentStep.title ?? card.currentStep.toolCallId}
                </span>
              )}
              <span className="shrink-0 text-2xs text-text-muted tabular-nums">{elapsed}</span>
            </div>
            <StepList card={card} ownerName={ownerName} limit={3} />
          </>
        ) : (
          (card.steps.length > 0 || status !== 'done') && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="flex h-6 w-fit items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"
                data-testid="session-summary"
              >
                {status !== 'done' && (
                  <DotMatrix state={status === 'failed' ? 'failed' : 'stopped'} size="sm" className="mr-0.5" />
                )}
                <ChevronRight
                  className={cn('size-3 transition-transform duration-150', expanded && 'rotate-90')}
                  strokeWidth={1.5}
                />
                {summaryLine(card, elapsed)}
              </button>
              {expanded && (
                <>
                  <StepList card={card} ownerName={ownerName} />
                  <button
                    type="button"
                    onClick={() => setTraceOpen(true)}
                    className="text-accent ml-5 w-fit text-xs hover:underline"
                    data-testid="session-open-trace"
                  >
                    Open full trace
                  </button>
                </>
              )}
            </div>
          )
        )}

        {pending && onResolvePermission && (
          <ApprovalCard
            request={pending}
            step={card.steps.find((s) => s.toolCallId === pending.toolCallId)}
            agentName={agentName}
            resolvingOptionId={resolving?.requestId === pending.requestId ? resolving.optionId : null}
            onResolve={(optionId) => {
              setResolving({ requestId: pending.requestId, optionId });
              onResolvePermission(pending.requestId, optionId);
            }}
          />
        )}

        {status === 'failed' && (
          <div
            className="border-danger/25 bg-danger/10 flex items-start gap-2 rounded-card border px-3 py-2"
            data-testid="session-failed-line"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={1.5} />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm text-text-primary">{agentName} couldn't finish</span>
              {card.failureReason && <span className="text-xs text-text-secondary">{card.failureReason}</span>}
            </div>
          </div>
        )}
        {status === 'stopped' && (
          <span className="bg-bg-2 flex w-fit items-center gap-1.5 rounded-chip px-2.5 py-1 text-xs text-text-secondary">
            <Square className="size-2.5" strokeWidth={1.5} fill="currentColor" />
            Stopped{card.finalAnswer ? ' partway' : ''}
          </span>
        )}

        {card.finalAnswer && (
          <SafeMarkdown content={card.finalAnswer} className="text-sm leading-relaxed text-text-primary" />
        )}

        {card.outputs.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            {card.outputs.map((output) => (
              <FileCard
                key={output.path}
                output={output}
                onOpen={onOpenFile ? () => onOpenFile(output.path) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions float at the row's top-right on hover or focus. */}
      {((running && onStop) || (!running && card.finalAnswer)) && (
        <div className={cn('border-border-hairline bg-bg-1 shadow-soft absolute top-0 right-2 flex -translate-y-1/2 items-center gap-0.5 rounded-chip border p-0.5 transition-opacity group-hover:opacity-100 focus-within:opacity-100', stopping ? 'opacity-100' : 'opacity-0')}>
          {running && onStop ? (
            <button
              type="button"
              onClick={() => {
                setStopping(true);
                onStop();
              }}
              disabled={stopping}
              className="enabled:hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-chip px-2 text-xs text-text-primary transition-colors disabled:text-text-muted"
            >
              <Square className="size-2.5" strokeWidth={1.5} fill="currentColor" />
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(card.finalAnswer).then(() => setCopied(true));
              }}
              aria-label="Copy answer"
              title="Copy answer"
              className={cn(
                'hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-chip px-2 text-xs transition-colors',
                copied ? 'text-success' : 'text-text-secondary'
              )}
            >
              {copied ? <Check className="size-3.5" strokeWidth={1.5} /> : <Copy className="size-3.5" strokeWidth={1.5} />}
              {copied && 'Copied'}
            </button>
          )}
        </div>
      )}

      <Dialog open={traceOpen} onOpenChange={setTraceOpen}>
        <DialogContent className="top-3 right-3 bottom-3 left-auto flex max-h-none w-[min(640px,calc(100vw-1.5rem))] max-w-none translate-x-0 translate-y-0 flex-col">
          <div className="border-border-hairline flex h-11 shrink-0 items-center gap-2 border-b px-4">
            <AgentAvatar agent={meta.agent} owner={owner} size="sm" />
            <DialogTitle>
              {mine ? `Your ${agentName}` : `${ownerName}'s ${agentName}`}
              <span className="ml-2 text-xs font-normal text-text-muted">{summaryLine(card, elapsed)}</span>
            </DialogTitle>
          </div>
          <SessionTrace runId={meta.id} events={events} running={running} className="min-h-0 flex-1" />
        </DialogContent>
      </Dialog>
    </div>
  );
}
