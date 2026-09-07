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

/**
 * `thinking-orbs`'s only two tuned presets are 20 and 64 CSS px (see its
 * own `OrbSize` doc) — 24 isn't one of them. Discoverability round
 * (punch-list finding 4) asks for "~24px in the header", so the CANVAS
 * stays at the tuned 20px preset (a scaled-up untuned size would just be a
 * blurrier orb, not a bigger one) and a small CSS `scale` on its wrapper
 * gets the on-screen footprint to the requested ~24px instead.
 */
const ORB_CANVAS_SIZE = 20;
const ORB_DISPLAY_SCALE = 24 / ORB_CANVAS_SIZE;

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
 * tell the mode is live. `orbState` carries three readable states of its
 * own: paused/muted while off, `searching` while armed and idle (matches
 * the "select text to start" invitation), and `working` — a genuinely
 * different animation, not just a re-tinted copy of `searching` — while a
 * stroke is actually streaming against the document.
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
  const reducedMotion = prefersReducedMotion();

  const orbState = !on ? 'breathing' : streaming ? 'working' : 'searching';
  const label = selected ? selected.name : 'Paintbrush';
  const tooltip = on
    ? `Paintbrush on · ${selected ? selected.name : 'choose an agent'} — select text to start`
    : 'Paintbrush: select any text and tell an agent what to do with it';

  return (
    <div className="relative flex items-center">
      <div
        ref={controlRef}
        className={cn(
          'flex items-center rounded-control border transition-colors duration-200 ease-out motion-reduce:transition-none',
          on ? 'border-accent/40 bg-accent-subtle' : 'border-border-hairline bg-bg-1'
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
                className="flex items-center gap-1.5 rounded-control py-1 pr-2 pl-1"
              >
                <span
                  className="flex shrink-0 items-center justify-center"
                  style={{ width: ORB_CANVAS_SIZE * ORB_DISPLAY_SCALE, height: ORB_CANVAS_SIZE * ORB_DISPLAY_SCALE }}
                >
                  <span style={{ transform: `scale(${ORB_DISPLAY_SCALE})` }}>
                    <ThinkingOrb
                      state={orbState}
                      size={ORB_CANVAS_SIZE}
                      paused={!on || reducedMotion}
                      aria-hidden
                    />
                  </span>
                </span>
                {/* Armed state must be obvious from a glance, not just a hover
                    tooltip — the word "Paintbrush", or the agent's own name
                    once chosen, sits right beside the orb whenever the mode
                    is on. */}
                {on && (
                  <span className="popover-in flex items-center gap-1 text-xs font-medium text-accent">
                    {selected && <AgentIcon icon={selected.icon} size={12} className="shrink-0" />}
                    {label}
                  </span>
                )}
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
          aria-label="Choose the paintbrush agent"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-control',
            on ? 'text-accent/70 hover:text-accent' : 'text-text-muted hover:text-text-primary'
          )}
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

      <Popover
        anchor={controlRef}
        open={showCoachMark}
        onClose={dismissCoachMark}
        role="dialog"
        align="left"
        estimatedWidth={260}
        minWidth={240}
        ariaLabel="About the paintbrush"
      >
        <div className="max-w-64 px-2.5 py-2 text-xs text-text-secondary">
          <p>
            Paintbrush is on. Select any text in the document and describe a change or ask a
            question. Edits come back as suggestions you apply.
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
