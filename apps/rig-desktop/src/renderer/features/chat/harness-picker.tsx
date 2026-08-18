import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { cn } from '@renderer/lib/utils';
import type { RunnableAgent } from './use-runnable-agents';

const POPUP_MIN_WIDTH = 180;

/**
 * The harness picker — a designed dropdown replacing the native `<select>`,
 * portaled the same way the comments margin's `@`-mention menu is
 * (`comments-margin.tsx`'s `useAnchorRect` pattern, factored out to
 * `lib/hooks/use-anchor-rect.ts` so this isn't a third hand-rolled copy).
 *
 * Focus never leaves the trigger button while open: options select via
 * `onMouseDown` + `preventDefault` (same trick the mention menu uses), so a
 * click never blurs the trigger, and a real outside click or Tab-away does —
 * that's the whole dismiss mechanism, no document-level listener needed.
 *
 * `variant`: `'field'` is the standalone picker (fixed width, bordered
 * field). `'chip'` is the same dropdown behind a compact pill trigger, for
 * the composer's bottom utility row (round 13's "cockpit") — the popup
 * still gets a real min-width regardless of how narrow the chip itself is.
 */
export function HarnessPicker({
  agents,
  selectedId,
  onChange,
  disabled,
  variant = 'field',
}: {
  agents: RunnableAgent[];
  selectedId: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
  variant?: 'field' | 'chip';
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // ~34px/row (icon + text-sm row at px-2.5 py-1.5) + 8px list padding —
  // close enough to pick the right side; `maxHeight` below is the real
  // safety net if this guess is off.
  const rect = useAnchorRect(open, triggerRef, {
    estimatedHeight: agents.length * 34 + 8,
    estimatedWidth: POPUP_MIN_WIDTH,
  });
  const selected = agents.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) return;
    const index = agents.findIndex((a) => a.id === selectedId);
    setHighlight(index >= 0 ? index : 0);
  }, [open, agents, selectedId]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (!open) {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen(true);
            }
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlight((i) => (i + 1) % agents.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlight((i) => (i - 1 + agents.length) % agents.length);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const target = agents[highlight];
            if (target) select(target.id);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
        }}
        className={cn(
          'focus-visible:outline-accent flex items-center outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50',
          variant === 'field'
            ? 'border-border-hairline bg-bg-1 text-text-primary hover:bg-bg-2 w-56 gap-2 rounded-control border px-2.5 py-1.5 text-sm'
            : 'bg-bg-2 text-text-secondary hover:text-text-primary w-fit gap-1.5 rounded-control px-2 py-1 text-xs'
        )}
      >
        {selected ? (
          <>
            <AgentIcon icon={selected.icon} size={variant === 'field' ? 14 : 12} />
            <span className="min-w-0 flex-1 truncate text-left">{selected.name}</span>
          </>
        ) : (
          <span className="text-text-muted flex-1 text-left">Choose an agent…</span>
        )}
        <ChevronDown
          className={cn('text-text-muted shrink-0', variant === 'field' ? 'size-3.5' : 'size-3')}
          strokeWidth={1.5}
        />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            role="listbox"
            style={{
              position: 'fixed',
              width: Math.max(rect.width, POPUP_MIN_WIDTH),
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
          >
            {agents.map((agent, index) => (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={agent.id === selectedId}
                onMouseDown={(event) => {
                  // Keeps focus on the trigger — a plain click here would
                  // blur it first and close the popup before this handler runs.
                  event.preventDefault();
                  select(agent.id);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm',
                  index === highlight
                    ? 'bg-bg-2 text-text-primary'
                    : 'text-text-secondary'
                )}
              >
                <AgentIcon icon={agent.icon} size={14} />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
