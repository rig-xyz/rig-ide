import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import type { RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { PaintbrushOrb } from './paintbrush-orb';

/**
 * Discoverability round (punch-list finding 4) asks for "~24px in the
 * header" — bigger than `PaintbrushOrb`'s own default (the library's tuned
 * 20px inline preset), so this is the one caller that overrides `size`.
 */
const ORB_DISPLAY_SIZE = 16;

/**
 * The paintbrush header control (`docs/document-focus-design.md` §2, step
 * 1; discoverability pass per the paintbrush v1 punch list, finding 4): an
 * animated orb that arms/disarms paintbrush mode, with a dropdown
 * (chevron) choosing which configured agent strokes are sent to. Sits to
 * the LEFT of `PreviewModeToggle` in `artifact-view.tsx`.
 *
 * Armed state is now unmissable, not just a color change on a tiny orb:
 * the whole pill picks up an accent tint AND a text label — "Paintbrush"
 * before an agent is chosen, the agent's own name once one is — so a
 * reader who glances at the header (not just whoever is hovering it) can
 * tell the mode is live. The orb (`PaintbrushOrb` — punch-list finding 3,
 * "one orb, everywhere") is the SAME `searching` animation in all three
 * states: paused and dimmed while off, resting pace while armed and idle
 * (matches the "select text to start" invitation), and faster (never a
 * different animation) while a stroke is actually streaming.
 *
 * The first time the mode is ever turned on, `showCoachMark` opens a small
 * dismissable popover explaining what just happened — the "what is a
 * paintbrush?" gap the punch list called out. Persisted (never shown
 * again once dismissed) via `rig.settings`'s `paintbrushCoachMarkSeen`,
 * the same mechanism `use-paintbrush.ts` already uses for the agent choice.
 */
export function PaintbrushControl({
  on,
  toggle,
  agents,
  selected,
  selectAgent,
  streaming,
  showCoachMark,
  dismissCoachMark,
}: {
  on: boolean;
  toggle: () => void;
  agents: RunnableAgent[];
  selected: RunnableAgent | null;
  selectAgent: (id: string) => void;
  /** A paintbrush thread's stroke is currently streaming against the document — the orb reflects it. */
  streaming: boolean;
  showCoachMark: boolean;
  dismissCoachMark: () => void;
}) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);

  const orbSpin = !on ? 'off' : streaming ? 'streaming' : 'idle';
  const agentName = selected?.name ?? 'an agent';
  const tooltip = on
    ? `Editing with ${agentName}. Highlight any text and type what you want changed.`
    : `Edit with ${agentName}. Turn on, then highlight any text and type what you want changed.`;

  // Sized and styled exactly like the neighboring Preview/Edit toggle (same
  // shell, same inner padding), so the header reads as one row of controls.
  // No word for the feature anywhere: the orb is the switch, the agent is
  // the label, and the tooltip says what it does in plain terms.
  return (
    <div className="relative flex items-center">
      <div
        ref={controlRef}
        className={cn(
          'flex items-center gap-0.5 rounded-control border bg-bg-1 p-0.5 transition-colors duration-200 ease-out motion-reduce:transition-none',
          on ? 'border-accent/40' : 'border-border-hairline'
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={on}
                aria-label={on ? `Stop editing with ${agentName}` : `Edit with ${agentName}`}
                onClick={toggle}
                className={cn(
                  'flex items-center rounded-control px-1.5 py-1 transition-colors duration-200 ease-out motion-reduce:transition-none',
                  on ? 'bg-accent-subtle' : 'hover:bg-bg-2'
                )}
              >
                <PaintbrushOrb spin={orbSpin} size={ORB_DISPLAY_SIZE} />
              </button>
            }
          />
          <TooltipContent side="bottom">{tooltip}</TooltipContent>
        </Tooltip>

        <button
          ref={chevronRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Choose which agent edits"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex items-center gap-1 rounded-control px-1.5 py-1 text-xs transition-colors duration-200 ease-out motion-reduce:transition-none',
            'hover:bg-bg-2 hover:text-text-primary',
            on ? 'text-text-primary' : 'text-text-muted'
          )}
        >
          {selected ? (
            <>
              <AgentIcon icon={selected.icon} size={12} className="shrink-0" />
              <span className="max-w-28 truncate">{selected.name}</span>
            </>
          ) : (
            <span>Choose agent</span>
          )}
          <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
        </button>
      </div>

      <Popover
        anchor={chevronRef}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        align="right"
        estimatedWidth={180}
        minWidth={180}
        ariaLabel="Paintbrush agent"
      >
        {agents.length === 0 ? (
          <p className="px-2.5 py-1.5 text-xs text-text-muted">No agents installed.</p>
        ) : (
          agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={agent.id === selected?.id}
              onClick={() => {
                selectAgent(agent.id);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-sm text-text-secondary outline-none transition-colors',
                'hover:bg-bg-2 hover:text-text-primary focus-visible:bg-bg-2',
                agent.id === selected?.id && 'text-text-primary'
              )}
            >
              <AgentIcon icon={agent.icon} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            </button>
          ))
        )}
      </Popover>

      <Popover
        anchor={controlRef}
        open={showCoachMark}
        onClose={dismissCoachMark}
        role="dialog"
        align="left"
        estimatedWidth={260}
        minWidth={240}
        ariaLabel="How editing with an agent works"
      >
        <div className="max-w-64 px-2.5 py-2 text-xs text-text-secondary">
          <p>
            Highlight any text in the document and type what you want changed.{' '}
            {selected ? selected.name : 'The agent'} suggests an edit in the margin. Apply it, or
            keep it as a comment.
          </p>
          <button
            type="button"
            onClick={dismissCoachMark}
            className="mt-2 text-xs font-medium text-accent hover:underline"
          >
            Got it
          </button>
        </div>
      </Popover>
    </div>
  );
}
