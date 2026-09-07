import { ChevronDown } from 'lucide-react';
import { ThinkingOrb } from 'thinking-orbs';
import { useRef, useState } from 'react';
import type { RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';

/** Cheap and read once — this is a decorative nicety, not something that needs to react live to a mid-session OS setting change. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const ORB_SIZE = 20;

/**
 * The paintbrush header control (`docs/document-focus-design.md` §2, step
 * 1): an animated orb that arms/disarms paintbrush mode, with a dropdown
 * (chevron) choosing which configured agent strokes are sent to. Sits to the
 * LEFT of `PreviewModeToggle` in `artifact-view.tsx`.
 *
 * Orb: `thinking-orbs` (MIT, zero deps, React 18+ peer — license and specs
 * checked before adding; see the paintbrush build report). Its `breathing`
 * state is the tuned "gentle idle" animation this button asks for; `paused`
 * freezes it on a single frame rather than removing the canvas, so the
 * button doesn't visually jump when the mode toggles off.
 *
 * Pill: only once a mode AND an agent are both chosen — otherwise the
 * control stays a single circular orb button, matching the "quiet until
 * meaningful" shape the rest of the header chrome (`comments`/`Share`
 * buttons) already follows. Width/opacity of the model segment transitions
 * over the house motion budget (150–250ms, state-driven, `motion-reduce`
 * gated — `file-navigator-design.md` §3.5).
 */
export function PaintbrushControl({
  on,
  toggle,
  agents,
  selected,
  selectAgent,
}: {
  on: boolean;
  toggle: () => void;
  agents: RunnableAgent[];
  selected: RunnableAgent | null;
  selectAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const expanded = on && selected !== null;

  return (
    <div className="flex items-center">
      <div
        className={cn(
          'flex items-center rounded-control border border-border-hairline transition-[background-color] duration-200 ease-out motion-reduce:transition-none',
          expanded ? 'bg-bg-2' : 'bg-bg-1'
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={on}
                aria-label={on ? 'Turn off the paintbrush' : 'Turn on the paintbrush'}
                onClick={toggle}
                className="flex size-6 shrink-0 items-center justify-center rounded-control"
              >
                <ThinkingOrb
                  state="breathing"
                  size={ORB_SIZE}
                  paused={!on || prefersReducedMotion()}
                  aria-hidden
                />
              </button>
            }
          />
          <TooltipContent side="bottom">
            {on ? 'Paintbrush on — select text to prompt an agent' : 'Turn on the paintbrush'}
          </TooltipContent>
        </Tooltip>

        {/* The model segment: rendered only once armed with a chosen agent —
            width/opacity transition in rather than popping, so arming reads
            as one continuous gesture. */}
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none',
            expanded ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0'
          )}
        >
          <div className="min-w-0 overflow-hidden">
            {selected && (
              <div className="flex items-center gap-1 border-l border-border-hairline py-1 pr-1 pl-1.5">
                <Tooltip>
                  {/* `TooltipTrigger`'s `render` needs a ref-forwardable host
                      element to anchor to — `AgentIcon` is a plain function
                      component, so it's wrapped in a `span` rather than
                      passed directly (matches this codebase's own
                      `render={<span>...</span>}` convention elsewhere). */}
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0">
                        <AgentIcon icon={selected.icon} size={13} />
                      </span>
                    }
                  />
                  <TooltipContent side="bottom">{selected.name}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
        </div>

        <button
          ref={chevronRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Choose the paintbrush agent"
          onClick={() => setOpen((v) => !v)}
          className="flex size-6 shrink-0 items-center justify-center rounded-control text-text-muted hover:text-text-primary"
        >
          <ChevronDown className="size-3" strokeWidth={1.5} />
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
    </div>
  );
}
