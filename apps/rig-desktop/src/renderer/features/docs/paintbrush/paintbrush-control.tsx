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

/** The user-facing name of the feature (the code keeps calling it the paintbrush). */
const FEATURE_NAME = 'Smart Highlighter';

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

  // Sized and styled exactly like the neighboring Preview/Edit toggle: same
  // shell, same inner padding, and the SAME neutral selected fill (bg-bg-2)
  // when on, so the header reads as one row of controls. The orb is the
  // switch; hovering the control unfolds the feature's name beside it
  // (inside the pill, not a tooltip), and the agent's logo is the only
  // other label, with its name on hover and in the menu.
  return (
    <div className="relative flex items-center">
      <div
        ref={controlRef}
        className="group flex items-center gap-0.5 rounded-control border border-border-hairline bg-bg-1 p-0.5"
      >
        <button
          type="button"
          aria-pressed={on}
          aria-label={on ? `Turn off ${FEATURE_NAME}` : `Turn on ${FEATURE_NAME}`}
          onClick={toggle}
          className={cn(
            'flex items-center rounded-control px-1.5 py-1 transition-colors duration-200 ease-out motion-reduce:transition-none',
            // On: the toggle's neutral fill plus a neutral inset outline —
            // bg-bg-2 alone is close to invisible on the light theme.
            on ? 'bg-bg-2 ring-1 ring-inset ring-border-strong' : 'hover:bg-bg-2/60'
          )}
        >
          <span className="relative flex items-center">
            <PaintbrushOrb spin={orbSpin} size={ORB_DISPLAY_SIZE} />
            {/* A small status dot on the orb's shoulder while on: the app's
                existing "live" vocabulary (unread threads, an agent editing
                now), readable in both themes without tinting the control. */}
            {on && (
              <span
                aria-hidden
                className="bg-accent absolute -top-0.5 -right-0.5 size-1.5 rounded-chip ring-2 ring-bg-2"
              />
            )}
          </span>
          {/* The name unfolds from behind the orb while the pill is hovered
              or keyboard-focused, and folds away again; width and opacity
              animate together so the row grows smoothly rather than popping. */}
          <span
            className={cn(
              'max-w-0 overflow-hidden text-xs font-normal whitespace-nowrap opacity-0',
              'transition-[max-width,opacity,margin] duration-200 ease-out motion-reduce:transition-none',
              'group-focus-within:ml-1.5 group-focus-within:max-w-40 group-focus-within:opacity-100',
              'group-hover:ml-1.5 group-hover:max-w-40 group-hover:opacity-100',
              on ? 'text-text-primary' : 'text-text-muted'
            )}
          >
            {FEATURE_NAME}
          </span>
        </button>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={chevronRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`${agentName}. Choose which agent edits`}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                  'flex items-center gap-1 rounded-control px-1.5 py-1 text-xs transition-colors duration-200 ease-out motion-reduce:transition-none',
                  'hover:bg-bg-2/60 hover:text-text-primary',
                  on ? 'text-text-primary' : 'text-text-muted'
                )}
              >
                {selected ? (
                  <AgentIcon icon={selected.icon} size={14} className="shrink-0" />
                ) : (
                  <span>Choose agent</span>
                )}
                <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
              </button>
            }
          />
          <TooltipContent side="bottom">
            {selected ? `${selected.name}. Choose which agent edits.` : 'Choose which agent edits.'}
          </TooltipContent>
        </Tooltip>
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
        ariaLabel={`How ${FEATURE_NAME} works`}
      >
        <div className="max-w-64 px-2.5 py-2 text-xs text-text-secondary">
          <p className="mb-1 font-medium text-text-primary">{FEATURE_NAME}</p>
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
