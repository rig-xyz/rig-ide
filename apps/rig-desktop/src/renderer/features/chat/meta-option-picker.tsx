import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { cn } from '@renderer/lib/utils';
import { compactOptionLabel } from './option-label';

/**
 * A quiet metadata dropdown for the composer's bottom utility row — the
 * live session's model/effort control (round: "model selection UI"). Same
 * trigger-button-plus-portaled-listbox mechanics as `HarnessPicker`
 * (`useAnchorRect`'s own placement flip is what makes this open UPWARD near
 * the composer, which sits at the bottom of the window — Dylan's earlier
 * feedback was a dropdown that opened downward off-screen; this hook is
 * the actual fix, reused rather than re-solved), but its own small
 * component rather than a generalized `HarnessPicker`: there's no
 * per-option icon here (a model/effort tier isn't a visual identity, it's
 * text metadata — Rule 4/7), so the trigger and each option render the
 * option's `name` in mono rather than reserving an icon slot nothing
 * would ever fill.
 *
 * Follow-up round (Dylan's screenshot: chunky filled pills, "Default
 * (rec…" truncating mid-word): the trigger carries NO background by
 * default — it's metadata, not primary chrome, so a fill only appears on
 * hover as the interactive affordance. The trigger also shows
 * `compactOptionLabel(selected.name)` (strips a trailing "(...)"
 * annotation like "(recommended)"), while the dropdown's own option rows
 * below show the untouched, full name — nothing is hidden at the moment
 * someone is actually choosing, only in the closed one-line summary.
 *
 * Always driven by the store's live options/selection (never local state)
 * — `onChange` writes straight through to the session, and the next
 * render reflects whatever the runtime actually confirmed, not an
 * optimistic guess.
 */
export function MetaOptionPicker({
  options,
  selectedId,
  onChange,
  placeholder,
  compact = false,
}: {
  options: { id: string; name: string }[];
  selectedId: string | null;
  onChange: (id: string) => void;
  /** Trigger text when nothing is selected yet — shouldn't normally happen once a session reports options, but keeps the control honest rather than blank. */
  placeholder: string;
  /**
   * Composer overlap round — narrower trigger truncation at low composer
   * widths (`composer-density.ts`). The model picker is this ladder's one
   * priority element: it always keeps a label, just a shorter one, rather
   * than dropping to icon-or-hide like effort/permission-mode do (this
   * component has no icon slot to fall back to at all — see the file
   * header comment).
   */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rect = useAnchorRect(open, triggerRef, { estimatedHeight: options.length * 30 + 8, estimatedWidth: 140 });
  const selected = options.find((o) => o.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) return;
    const index = options.findIndex((o) => o.id === selectedId);
    setHighlight(index >= 0 ? index : 0);
  }, [open, options, selectedId]);

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (!open) {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen(true);
            }
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlight((i) => (i + 1) % options.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlight((i) => (i - 1 + options.length) % options.length);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const target = options[highlight];
            if (target) select(target.id);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
        }}
        className="text-text-muted hover:text-text-primary hover:bg-bg-2 focus-visible:outline-accent flex w-fit shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-xs outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span className={cn('truncate font-mono', compact ? 'max-w-14' : 'max-w-32')}>
          {selected ? compactOptionLabel(selected.name) : placeholder}
        </span>
        <ChevronDown className="size-2.5 shrink-0" strokeWidth={1.5} />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            role="listbox"
            style={{
              position: 'fixed',
              width: Math.max(rect.width, 140),
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
          >
            {options.map((option, index) => {
              // D1 fix: `highlight` (keyboard/hover position) used to be the
              // ONLY visual signal — moving the mouse over a different row
              // made the true selection indistinguishable from any other
              // option. Now the highlight stays purely transient (bg only)
              // and the actual selection gets its own PERSISTENT marker (a
              // checkmark + primary text) that survives regardless of where
              // the mouse/keyboard focus currently sits — same persistent-
              // selection principle `permission-mode-picker.tsx` uses.
              const isSelected = option.id === selectedId;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => {
                    // Same trick `HarnessPicker` uses — keeps focus on the
                    // trigger so a plain click doesn't blur it and close the
                    // popup before this handler runs.
                    event.preventDefault();
                    select(option.id);
                  }}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left font-mono text-xs',
                    index === highlight && 'bg-bg-2',
                    isSelected ? 'text-text-primary' : 'text-text-secondary'
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.name}</span>
                    {/* Round: model picker id subtext — "which version is
                        Default" is unanswerable from the display name alone
                        (ACP options carry a real id, e.g. an adapter's
                        `Default` tier maps to a specific dated model
                        string). Muted, never invented: only shown when it's
                        genuinely a DIFFERENT string from what's already
                        displayed above it. */}
                    {option.id !== option.name && (
                      <span className="text-text-muted mt-0.5 block truncate text-xs">
                        {option.id}
                      </span>
                    )}
                  </span>
                  {isSelected && <Check className="size-3 shrink-0" strokeWidth={1.5} />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
