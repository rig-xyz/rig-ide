import { Check, ChevronDown, MessageCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import type { RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Popover } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import { ContextPill } from '@renderer/features/spaces/components/context-pill';

/**
 * The pieces of comment mode (canvas board 16) that files and pages share:
 * the header control, the status pill while it's on, and the pill beside a
 * text selection while it's off. Controls stay neutral when on; accent is
 * kept for what you're pointing at.
 */

/** An agent's short name, as people say it: "Claude Code" → "Claude", "Gemini CLI" → "Gemini". */
export function shortAgentName(name: string): string {
  return name.replace(/\s+(code|cli)$/i, '');
}

/**
 * How many comments are open, with a quiet toggle for the resolved ones:
 * the left half of the comments group. Nothing when there are none.
 */
export function CommentCount({
  open,
  resolved,
  showResolved,
  onToggleResolved,
}: {
  open: number;
  resolved: number;
  showResolved: boolean;
  onToggleResolved: () => void;
}) {
  if (open === 0 && resolved === 0) return null;
  return (
    <span className="text-text-muted flex h-7 items-center gap-1 px-1 text-xs" data-testid="comment-count">
      <MessageCircle className="size-3.5 shrink-0" strokeWidth={1.5} />
      {open > 0 && (
        <span className="text-text-secondary tabular-nums" title={`${open} open`}>
          {open}
        </span>
      )}
      {resolved > 0 && (
        <button
          type="button"
          onClick={onToggleResolved}
          aria-pressed={showResolved}
          className={cn(
            'rounded-control px-1 transition-colors hover:text-text-primary',
            showResolved && 'bg-bg-2 text-text-primary'
          )}
          data-testid="resolved-toggle"
        >
          {open > 0 ? '· ' : ''}
          {resolved} resolved
        </button>
      )}
    </span>
  );
}

/** You get a speech bubble; an agent gets its own logo. */
export function WhoIcon({ who, size = 14 }: { who: RunnableAgent | null; size?: number }) {
  return who ? (
    <AgentIcon icon={who.icon} size={size} className="shrink-0" />
  ) : (
    <MessageCircle className="shrink-0" style={{ width: size, height: size }} strokeWidth={1.5} />
  );
}

/**
 * The comments group in a file's or a page's header, shaped like the top
 * bar's people-and-invite trigger (Dylan, 2026-09-26): what's there on the
 * left (`count`, see `CommentCount`), the action as a quiet pill on the
 * right: "Comment ▾" or "Ask Claude ▾" (canvas board 17, option B). An
 * outline around the whole group on hover; no accent, it was too loud. The
 * pill's main part turns comment mode on, its chevron picks who.
 */
export function CommentModeControl({
  on,
  toggle,
  who,
  agents,
  pick,
  count,
  testId,
}: {
  on: boolean;
  toggle: () => void;
  who: RunnableAgent | null;
  /** The agents that can be asked here; none hides the chevron. */
  agents: RunnableAgent[];
  pick: (agentId: string | null) => void;
  /** The comment count on the pill's left (`CommentCount`). */
  count?: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="rounded-chip flex h-8 shrink-0 items-center gap-1 py-0.5 pr-0.5 pl-1 ring-1 ring-transparent transition-shadow duration-150 hover:ring-border-hairline has-[:focus-visible]:ring-border-hairline motion-reduce:transition-none"
      data-testid={testId}
    >
      {count}
      <div
        className={cn(
          'rounded-chip text-text-primary flex h-7 items-center text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
          // On: held down, a neutral edge (accent is for what you're pointing at).
          on ? 'bg-bg-2 ring-border-strong ring-1 ring-inset' : 'bg-bg-2/70 hover:bg-bg-2'
        )}
      >
        <button
          type="button"
          aria-pressed={on}
          onClick={toggle}
          className={cn('flex h-7 items-center gap-1.5 rounded-chip', agents.length > 0 ? 'pr-1 pl-2.5' : 'px-2.5')}
          data-testid={testId && `${testId}-toggle`}
        >
          <WhoIcon who={who} size={14} />
          <span className="max-w-32 truncate">{who ? `Ask ${shortAgentName(who.name)}` : 'Comment'}</span>
        </button>
        {agents.length > 0 && (
          <button
            ref={chevronRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Choose who you're talking to"
            onClick={() => setOpen((v) => !v)}
            className="text-text-muted flex h-7 items-center rounded-chip pr-2 pl-0.5 hover:text-text-primary"
            data-testid={testId && `${testId}-who`}
          >
            <ChevronDown className="size-3" strokeWidth={2} />
          </button>
        )}
      </div>
      <Popover
        anchor={chevronRef}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        align="right"
        estimatedWidth={220}
        minWidth={220}
        ariaLabel="Who you're talking to"
      >
        <WhoItem label="Comment" selected={who === null} onPick={() => (pick(null), setOpen(false))}>
          <WhoIcon who={null} />
        </WhoItem>
        <div className="border-border-hairline mt-1 max-h-56 overflow-y-auto border-t pt-1">
          {agents.map((agent) => (
            <WhoItem
              key={agent.id}
              label={`Ask ${shortAgentName(agent.name)}`}
              selected={who?.id === agent.id}
              onPick={() => (pick(agent.id), setOpen(false))}
            >
              <WhoIcon who={agent} />
            </WhoItem>
          ))}
        </div>
        <p className="border-border-hairline mt-1 flex items-center gap-1.5 border-t px-2.5 pt-2 pb-1 text-2xs text-text-muted">
          <Kbd>Esc</Kbd> leaves comment mode
        </p>
      </Popover>
    </div>
  );
}

function WhoItem({ label, selected, onPick, children }: { label: string; selected: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      tabIndex={-1}
      aria-checked={selected}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-bg-2 focus-visible:bg-bg-2',
        selected ? 'text-text-primary' : 'text-text-secondary'
      )}
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check className="size-3.5 shrink-0" strokeWidth={1.5} />}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="border-border-strong rounded border px-1 font-mono text-2xs leading-4 text-text-muted">{children}</kbd>;
}

const GLASS =
  'popover-in shadow-float border-border-hairline flex h-[30px] items-center gap-1.5 rounded-full border bg-[var(--pill-fill)]/80 text-xs whitespace-nowrap backdrop-blur-md';

/**
 * While comment mode is on (and no draft is open): a clear glass pill at the
 * bottom of the view, so it never stays on unnoticed. The composer's liquid
 * pill: hovering it lets "×" ooze out, which leaves the mode (as Esc does).
 * Place it in a relative container.
 */
export function CommentModeStatus({ who, onLeave }: { who: RunnableAgent | null; onLeave: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center" data-testid="comment-mode-status">
      <div className="popover-in pointer-events-auto">
        <ContextPill clear onDismiss={onLeave} dismissLabel="Leave comment mode" testId="comment-mode-pill">
          <WhoIcon who={who} size={13} />
          <b className="font-medium text-text-primary">{who ? `Asking ${shortAgentName(who.name)}` : 'Commenting'}</b>
          <Kbd>Esc</Kbd>
        </ContextPill>
      </div>
    </div>
  );
}

export const SELECTION_PILL_HEIGHT = 30;
const FACES = 2;

/** The pill's width, for placing it: "Comment" plus one logo per agent shown. */
export function selectionPillWidth(agents: RunnableAgent[]): number {
  const faces = Math.min(agents.length, FACES);
  return 96 + (faces > 0 ? 9 + faces * 26 : 0);
}

/**
 * Beside a text selection while comment mode is off: Comment, plus one-click
 * asks for your first two agents (the rest are in the header's menu).
 */
export function CommentSelectionPill({
  top,
  left,
  agents,
  onComment,
  onAsk,
}: {
  top: number;
  left: number;
  agents: RunnableAgent[];
  onComment: () => void;
  onAsk: (agent: RunnableAgent) => void;
}) {
  const faces = agents.slice(0, FACES);
  return (
    <div
      // Keep the selection: a plain click here would blur it away.
      onMouseDown={(event) => event.preventDefault()}
      style={{ top, left }}
      className={cn(GLASS, 'fixed z-50 px-0.5')}
      data-testid="comment-selection-pill"
    >
      <button
        type="button"
        onClick={onComment}
        className="flex h-6 items-center gap-1.5 rounded-full px-2.5 text-text-primary hover:bg-bg-2/70"
      >
        <MessageCircle className="size-3.5 shrink-0" strokeWidth={1.5} />
        Comment
      </button>
      {faces.length > 0 && <span className="bg-border-hairline h-3.5 w-px" aria-hidden />}
      {faces.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onAsk(agent)}
          aria-label={`Ask ${shortAgentName(agent.name)}`}
          title={`Ask ${shortAgentName(agent.name)}`}
          className="grid size-6 place-items-center rounded-full hover:bg-bg-2/70"
        >
          <AgentIcon icon={agent.icon} size={14} />
        </button>
      ))}
    </div>
  );
}
