import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Globe,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  Square,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock, formatElapsed } from '@renderer/lib/time-format';
import { Button } from '@renderer/lib/ui/button';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { Dialog, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { Popover, PopoverMenuItem } from '@renderer/lib/ui/popover';
import { DotMatrix, type DotMatrixActivity, type DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';
import {
  connectorById,
  prettyAgentTool,
  type ConnectorDef,
  type ConnectResult,
  type GlobalServer,
  type RigToolArgs,
} from '@shared/spaces/connectors';
import { ConnectPill } from './connectors-panel';
import { globalAgentsFor } from '../global-setup';
import { ConnectorLogo } from '../logos';
import { effectiveRunStatus, projectSessionCard } from '../projection';
import type {
  AgentKind,
  RoomConnector,
  RoomMember,
  RoomReplyRef,
  SessionCard as SessionCardData,
  SessionEvent,
  SessionOutput,
  SessionPermissionDecided,
  SessionPermissionPending,
  SessionPlanEntry,
  SessionRunMeta,
  SessionStep,
} from '../types';
import { AGENT_NAME, AgentAvatar } from './identity';
import { SessionTrace } from './session-trace';
import { excerptOf, ROW_GRID, RowActions, RowTime } from './transcript-items';

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

/**
 * A step or live-line title, prettified via `prettyAgentTool`: a connector
 * rig injected ("space") always prettifies with its brand mark; a tool one
 * of the agent's OWN global setup brings ("setup") only prettifies when
 * it's also a catalog connector (so its name/logo are ones we actually
 * know) — an uncataloged global tool falls back to the raw title, same as
 * before. A "setup" tool's tooltip names the run's agent, so "Linear · list
 * issues" reads as coming from your Claude setup rather than a connector
 * rig itself wired up. Rig's own tools ("rig") read as "Rig · invite
 * hugo@…", with the rig mark and no connector.
 */
function prettyStepTitle(
  raw: string | undefined,
  agent: AgentKind,
  args?: RigToolArgs
): { text: string; connector: ConnectorDef | null; tooltip?: string } | null {
  if (!raw) return null;
  const pretty = prettyAgentTool(raw, args);
  if (pretty?.via === 'rig') return { text: `${pretty.label} · ${pretty.action}`, connector: null };
  if (!pretty || !pretty.connector) return null;
  return {
    text: `${pretty.label} · ${pretty.action}`,
    connector: pretty.connector,
    tooltip: pretty.via === 'setup' ? `From your ${AGENT_NAME[agent]} setup` : undefined,
  };
}

function StepRow({
  step,
  decided,
  ownerName,
  agent,
}: {
  step: SessionStep;
  decided: SessionPermissionDecided | undefined;
  ownerName: string;
  /** The run's agent, so a global-setup tool's tooltip names it ("From your Claude setup"). */
  agent: AgentKind;
}) {
  const kind = stepKind(step.kind);
  const failed = step.status === 'failed';
  const live = step.status === 'pending' || step.status === 'in_progress';
  const Icon = kind.icon;
  const decision = decided ? decisionLabel(decided) : null;
  const pretty = prettyStepTitle(step.title, agent, step.args);
  return (
    <li className="flex min-w-0 flex-col" data-testid="session-step">
      <div className="flex h-6 min-w-0 items-center gap-2 text-xs text-text-secondary">
        {live ? (
          <DotMatrix state={kind.matrix} size="sm" className="mx-0.5" />
        ) : failed ? (
          <X className="size-3.5 shrink-0 text-danger" strokeWidth={1.5} />
        ) : pretty?.connector ? (
          <ConnectorLogo id={pretty.connector.id} name={pretty.connector.name} brand={pretty.connector.brand} size={14} className="rounded" />
        ) : pretty ? (
          <RigMark size={14} className="shrink-0 text-text-muted" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        )}
        <span className="min-w-0 truncate" title={pretty?.tooltip ?? step.title}>
          {pretty ? pretty.text : (step.title ?? kind.past)}
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
  agent,
  limit,
  finishedOnly = false,
}: {
  card: SessionCardData;
  ownerName: string;
  /** The run's agent, forwarded to each `StepRow`. */
  agent: AgentKind;
  /** Show only the last N (while running); undefined shows all. */
  limit?: number;
  /** Leave out steps still in flight: while running, the live line already shows the current one. */
  finishedOnly?: boolean;
}) {
  const shown = finishedOnly
    ? card.steps.filter((s) => s.status !== 'pending' && s.status !== 'in_progress')
    : card.steps;
  const steps = limit ? shown.slice(-limit) : shown;
  if (steps.length === 0) return null;
  return (
    <ul className="border-border-hairline ml-1.5 flex flex-col border-l pl-3" data-testid="session-steps">
      {steps.map((step) => (
        <StepRow
          key={step.toolCallId}
          step={step}
          decided={card.permissions.decided.find((d) => d.toolCallId === step.toolCallId)}
          ownerName={ownerName}
          agent={agent}
        />
      ))}
    </ul>
  );
}

/** The agent's own plan: how far along, then each entry done, in progress, or ahead. */
function PlanBlock({ plan }: { plan: SessionPlanEntry[] }) {
  const done = plan.filter((e) => e.status === 'completed').length;
  return (
    <div className="flex flex-col gap-1.5" data-testid="session-plan">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-text-secondary">Plan</span>
        <span className="text-text-muted tabular-nums">
          {done} of {plan.length}
        </span>
        <span className="bg-bg-3 h-1 w-16 overflow-hidden rounded-full">
          <span
            className="bg-accent block h-full rounded-full transition-[width] duration-300"
            style={{ width: `${plan.length ? (done / plan.length) * 100 : 0}%` }}
          />
        </span>
      </div>
      <ul className="flex flex-col">
        {plan.map((entry, i) => (
          <li key={i} className="flex min-h-6 items-center gap-2 text-xs">
            {entry.status === 'completed' ? (
              <Check className="size-3.5 shrink-0 text-success" strokeWidth={1.5} />
            ) : entry.status === 'in_progress' ? (
              <DotMatrix state="planning" size="sm" className="mx-0.5" />
            ) : (
              <span className="border-text-muted mx-[3px] size-2 shrink-0 rounded-full border" />
            )}
            <span
              className={cn(
                'min-w-0',
                entry.status === 'completed' ? 'text-text-muted line-through decoration-text-muted/50' : 'text-text-secondary',
                entry.status === 'in_progress' && 'text-text-primary'
              )}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The agent's reasoning, folded away by default. */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="flex flex-col gap-1" data-testid="session-thinking">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-6 w-fit items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"
      >
        <Brain className="size-3.5" strokeWidth={1.5} />
        Thinking
        <span className="tabular-nums">· {words} words</span>
        <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} strokeWidth={1.5} />
      </button>
      {open && (
        <p className="border-border-hairline ml-1.5 border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-text-muted">
          {text.trim()}
        </p>
      )}
    </div>
  );
}

/** The last sentence of a stream of text, for a one-line glimpse. */
function lastSentence(text: string): string {
  const trimmed = text.trim();
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  return (parts[parts.length - 1] ?? trimmed).slice(-140);
}

/** The owner's approval ask: what it wants to do, the exact command or target, and the choices. */
function ApprovalCard({
  request,
  step,
  file,
  agentName,
  resolvingOptionId,
  onResolve,
}: {
  request: SessionPermissionPending;
  step: SessionStep | undefined;
  /** For an edit: the file and the lines it would change. */
  file?: SessionOutput;
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
  // Rig's own tools say what they'll do: "Rig · invite hugo@acme.co".
  const rigTool = prettyAgentTool(request.title, step?.args);
  const shownTitle = rigTool?.via === 'rig' ? `${rigTool.label} · ${rigTool.action}` : request.title;
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
      {file ? (
        <div className="border-border-hairline bg-bg-1 flex items-center gap-2 rounded-control border px-2.5 py-1.5 text-sm">
          <FileText className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
          <span className="min-w-0 truncate text-text-primary">{file.path.split('/').pop()}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-success">+{file.adds}</span>
            {file.dels > 0 && <span className="text-danger">−{file.dels}</span>}
          </span>
        </div>
      ) : (
        <code className="border-border-hairline bg-bg-1 rounded-control border px-2.5 py-1.5 font-mono text-xs break-all text-text-primary">
          {shownTitle}
        </code>
      )}
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

/**
 * The files an answer rests on: what the agent read, by the paths its tools
 * reported (or, failing that, a "Read <file>" title). Files it changed are
 * shown as file cards instead, so they're left out here.
 */
export function sourcesOf(card: SessionCardData): string[] {
  const changed = new Set(card.outputs.map((o) => o.path));
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const step of card.steps) {
    if (step.kind !== 'read' && step.kind !== 'search' && step.kind !== 'fetch') continue;
    const paths = step.locations?.map((l) => l.path).filter(Boolean) ?? [];
    if (paths.length === 0 && step.kind === 'read' && step.title?.startsWith('Read ')) {
      paths.push(step.title.slice(5).trim());
    }
    for (const path of paths) {
      if (changed.has(path) || seen.has(path)) continue;
      seen.add(path);
      sources.push(path);
    }
  }
  return sources;
}

function SourcesRow({ sources, onOpen }: { sources: string[]; onOpen?: (path: string) => void }) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="session-sources">
      <span className="mr-0.5 text-2xs text-text-muted">Sources</span>
      {sources.map((path) => {
        const name = path.split('/').pop() || path;
        return (
          <button
            key={path}
            type="button"
            onClick={onOpen ? () => onOpen(path) : undefined}
            disabled={!onOpen}
            title={path}
            className="border-border-hairline bg-bg-1 enabled:hover:border-border-strong enabled:hover:text-text-primary flex h-6 items-center gap-1.5 rounded-chip border px-2 text-xs text-text-secondary transition-colors"
          >
            <FileText className="size-3 shrink-0" strokeWidth={1.5} />
            <span className="max-w-48 truncate">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A file the agent changed, as something you can open. */
function FileCard({ output, onOpen }: { output: SessionOutput; onOpen?: () => void }) {
  const name = output.path.split('/').pop() ?? output.path;
  // Agents report absolute paths; the machine-specific prefix says nothing
  // useful here. A relative path's folder does.
  const dir = output.path.startsWith('/') ? '' : output.path.slice(0, Math.max(0, output.path.length - name.length - 1));
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

/** Retry this turn: straight away with the same agent, or pick one of your others from a small menu. */
function RetryButton({
  agent,
  otherAgents,
  onRerun,
}: {
  agent: AgentKind;
  otherAgents: AgentKind[];
  onRerun: (agent: AgentKind) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => (otherAgents.length > 0 ? setOpen(true) : onRerun(agent))}
        aria-label="Retry"
        title={otherAgents.length > 0 ? 'Retry…' : 'Retry'}
        aria-haspopup={otherAgents.length > 0 ? 'menu' : undefined}
        className="hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-chip px-2 text-xs text-text-secondary transition-colors"
      >
        <RotateCcw className="size-3.5" strokeWidth={1.5} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="right" minWidth={180}>
        <PopoverMenuItem label={`Again with ${AGENT_NAME[agent]}`} icon={RotateCcw} onSelect={() => { setOpen(false); onRerun(agent); }} />
        {otherAgents.map((other) => (
          <PopoverMenuItem
            key={other}
            label={`With ${AGENT_NAME[other]}`}
            onSelect={() => {
              setOpen(false);
              onRerun(other);
            }}
          />
        ))}
      </Popover>
    </>
  );
}

/** A running step's title for the live line; connector tools read as "Linear · list issues" (see `prettyStepTitle`). */
function liveStepTitle(title: string | undefined, agent: AgentKind, args?: RigToolArgs): string | undefined {
  return prettyStepTitle(title, agent, args)?.text ?? title;
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
  onReply,
  messageId,
  queued = false,
  onRerun,
  prompt,
  otherAgents = [],
  onConnectorConnect,
  spaceConnectors,
  globalSetup,
}: {
  meta: SessionRunMeta;
  events: SessionEvent[];
  owner: RoomMember | undefined;
  /** The viewer owns this agent: its name reads "yours" instead of "Sam's". Defaults to whether approvals were passed. */
  viewerIsOwner?: boolean;
  /** A follow-up turn from the same agent a moment later: no avatar or header. */
  continued?: boolean;
  /** Resolves false when nothing here could stop it. */
  onStop?: () => Promise<boolean> | void;
  /** Only passed for the viewer's OWN agent's run: approvals belong to the owner. */
  onResolvePermission?: (requestId: string, optionId: string) => void;
  /** Opens a changed file (its path as the agent reported it). */
  onOpenFile?: (path: string) => void;
  /** Starts a quote-reply to this answer. */
  onReply?: (ref: RoomReplyRef) => void;
  /** The Room message this run hangs off, for reply references. */
  messageId?: string;
  /** Another turn of the same agent is running ahead of this one: it waits its turn. */
  queued?: boolean;
  /** Your own run only: files a new turn for one of your agents with this prompt (Retry, Continue). */
  onRerun?: (agent: AgentKind, prompt: string) => void;
  /** What this run was asked, for Retry. */
  prompt?: string;
  /** Your other agents, offered by Retry. */
  otherAgents?: AgentKind[];
  /** Runs the connect flow for a footer gap pill (own run only — see `card.connectorGaps`). */
  onConnectorConnect?: (id: string) => Promise<ConnectResult>;
  /** The space's connectors as they are now, with your own state, so a gap you've since fixed stops asking. */
  spaceConnectors?: RoomConnector[];
  /** Your agents' own global MCP setup — a gap this run's own agent (`meta.agent`) already reaches this way is dropped rather than nagging you to connect it (dispatch stops recording these going forward; older runs still carry them). */
  globalSetup?: GlobalServer[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  useEffect(() => {
    if (!stopFailed) return;
    const id = setTimeout(() => setStopFailed(false), 4000);
    return () => clearTimeout(id);
  }, [stopFailed]);
  const [resolving, setResolving] = useState<{ requestId: string; optionId: string } | null>(null);
  const card = useMemo(() => projectSessionCard(events), [events]);
  // The run recorded what it couldn't reach; show only what's still missing
  // now (connected since: gone; removed from the space: gone; lapsed: Reconnect).
  const liveGaps = card.connectorGaps.flatMap((gap) => {
    if (globalSetup && globalAgentsFor(gap.id, globalSetup).has(meta.agent)) return [];
    if (!spaceConnectors) return [gap];
    const now = spaceConnectors.find((c) => c.id === gap.id);
    if (!now || now.mine === 'connected') return [];
    return [now.mine === 'expired' ? { ...gap, state: 'expired' as const } : gap];
  });
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
  // An edit waiting for approval hasn't happened yet: its file shows in the
  // approval card, not among the files this turn changed.
  const pendingStep = pending ? card.steps.find((s) => s.toolCallId === pending.toolCallId) : undefined;
  const pendingPaths = new Set(pendingStep?.locations?.map((l) => l.path) ?? []);
  const pendingFile =
    pendingStep && ['edit', 'delete', 'move'].includes(pendingStep.kind ?? '')
      ? card.outputs.find(
          (o) => pendingPaths.has(o.path) || (pendingStep.title ?? '').endsWith(o.path.split('/').pop() ?? '\0')
        )
      : undefined;
  const changedFiles = card.outputs.filter((o) => o !== pendingFile);
  // The live step's approval, once answered, reads under the live line (the step isn't in the list yet).
  const currentDecided = card.currentStep
    ? card.permissions.decided.find((d) => d.toolCallId === card.currentStep!.toolCallId)
    : undefined;
  const currentDecision = !pending && currentDecided ? decisionLabel(currentDecided) : null;

  const liveLabel = queued
    ? `Queued · after ${mine ? 'your' : `${ownerName}'s`} current ${agentName} turn`
    : pending
    ? onResolvePermission
      ? 'Waiting for your approval'
      : `Waiting on ${ownerName}'s approval`
    : card.currentStep
      ? (liveStepTitle(card.currentStep.title, meta.agent, card.currentStep.args) ?? currentKind.live)
      : events.length > 0
        ? 'Thinking'
        : 'Starting';
  // A running global-setup tool's tooltip, e.g. "From your Claude setup" —
  // same rule as the finished step list (`prettyStepTitle`).
  const liveTooltip =
    !queued && !pending && card.currentStep ? prettyStepTitle(card.currentStep.title, meta.agent)?.tooltip : undefined;
  const liveMatrix: DotMatrixState = queued
    ? 'queued'
    : pending
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
              <span className="active-shimmer-muted min-w-0 truncate" title={liveTooltip}>
                {liveLabel}
              </span>
              {!pending && !card.currentStep && card.thinking && !card.finalAnswer ? (
                <span className="min-w-0 truncate text-xs text-text-muted italic">{lastSentence(card.thinking)}</span>
              ) : null}
              <span className="shrink-0 text-2xs text-text-muted tabular-nums">{elapsed}</span>
            </div>
            {card.plan.length > 0 && <PlanBlock plan={card.plan} />}
            {currentDecision && (
              <span className="ml-6 text-2xs text-text-muted" data-testid="session-decision">
                <span className={currentDecision.allowed ? 'text-success' : 'text-danger'}>{currentDecision.text}</span> by{' '}
                {ownerName}
              </span>
            )}
            <StepList card={card} ownerName={ownerName} agent={meta.agent} limit={3} finishedOnly />
          </>
        ) : (
          (card.steps.length > 0 || card.plan.length > 0 || card.thinking.trim() !== '' || status !== 'done') && (
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
                  {card.thinking.trim() && <ThinkingBlock text={card.thinking} />}
                  {card.plan.length > 0 && <PlanBlock plan={card.plan} />}
                  <StepList card={card} ownerName={ownerName} agent={meta.agent} />
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
            file={pendingFile}
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
            {onRerun && prompt && (
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => onRerun(meta.agent, prompt)}>
                <RotateCcw />
                Retry
              </Button>
            )}
          </div>
        )}
        {status === 'stopped' && (
          <div className="flex items-center gap-2">
            <span className="bg-bg-2 flex w-fit items-center gap-1.5 rounded-chip px-2.5 py-1 text-xs text-text-secondary">
              <Square className="size-2.5" strokeWidth={1.5} fill="currentColor" />
              Stopped{card.finalAnswer ? ' partway' : ''}
            </span>
            {onRerun && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRerun(meta.agent, 'Continue where you left off.')}
                data-testid="session-continue"
              >
                Continue
              </Button>
            )}
          </div>
        )}

        {card.finalAnswer && status !== 'failed' && (
          <div data-highlight-target className="rounded-card">
            <SafeMarkdown content={card.finalAnswer} className="text-sm leading-relaxed text-text-prose" onOpenPath={onOpenFile} />
          </div>
        )}
        {card.finalAnswer && status === 'failed' && (
          <details className="text-xs text-text-muted">
            <summary className="w-fit cursor-pointer hover:text-text-secondary">What the agent printed</summary>
            <pre className="border-border-hairline bg-bg-1 mt-1 max-h-40 overflow-auto rounded-control border p-2 font-mono text-2xs whitespace-pre-wrap text-text-secondary">
              {card.finalAnswer}
            </pre>
          </details>
        )}
        {!running && card.finalAnswer && <SourcesRow sources={sourcesOf(card)} onOpen={onOpenFile} />}
        {mine && onConnectorConnect && liveGaps.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="session-connector-gaps">
            {liveGaps.map((gap) => {
              const def = connectorById(gap.id);
              const name = def?.name ?? gap.id;
              return (
                <span
                  key={gap.id}
                  className="bg-bg-2 border-border-hairline flex h-7 w-fit items-center gap-2 rounded-chip border pr-1 pl-2 text-xs text-text-secondary"
                  data-testid="connector-gap-pill"
                  data-connector={gap.id}
                >
                  {def && <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={16} />}
                  {gap.state === 'expired' ? `Your ${name} login expired` : `${name} isn't connected for you`}
                  <ConnectPill
                    label={gap.state === 'expired' ? 'Reconnect' : 'Connect'}
                    variant={gap.state === 'expired' ? 'warn' : 'accent'}
                    onConnect={() => onConnectorConnect(gap.id)}
                  />
                </span>
              );
            })}
          </div>
        )}

        {changedFiles.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            {changedFiles.map((output) => (
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
      <RowActions
        forceVisible={stopping || stopFailed}
        onReply={
          onReply && !running && card.finalAnswer
            ? () =>
                onReply({
                  id: messageId ?? meta.id,
                  authorId: meta.owner,
                  label: mine ? `Your ${agentName}` : `${ownerName}'s ${agentName}`,
                  excerpt: excerptOf(card.finalAnswer),
                })
            : undefined
        }
        copyText={!running && card.finalAnswer ? card.finalAnswer : undefined}
      >
        {running && onStop && (
          <button
            type="button"
            onClick={() => {
              setStopping(true);
              void Promise.resolve(onStop()).then((stopped) => {
                if (stopped === false) {
                  setStopping(false);
                  setStopFailed(true);
                }
              });
            }}
            disabled={stopping}
            className="enabled:hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-chip px-2 text-xs text-text-primary transition-colors disabled:text-text-muted"
          >
            <Square className="size-2.5" strokeWidth={1.5} fill="currentColor" />
            {stopping ? 'Stopping…' : stopFailed ? "Couldn't stop it from here" : queued ? 'Cancel' : 'Stop'}
          </button>
        )}
        {!running && onRerun && prompt && (
          <RetryButton agent={meta.agent} otherAgents={otherAgents} onRerun={(agent) => onRerun(agent, prompt)} />
        )}
      </RowActions>

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
