import { ChevronDown, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { cn } from '@renderer/lib/utils';
import { decideModeSelect, isDangerousMode } from './permission-mode';

export type PermissionModeOption = { id: string; name: string; description?: string };

/**
 * Round: permission mode control — the deliberately-deferred `modeOptions`
 * dimension, built as a genuine SAFETY control rather than a third
 * metadata dropdown (`MetaOptionPicker` handles model/effort; this is its
 * own component, not a reskin, because the interaction itself differs —
 * escalation friction, a persistent warning state — not just the colors).
 *
 * Trigger reads as a safety state, not metadata: a shield glyph (flips to
 * `ShieldOff`, warning-colored, the moment the ACTIVE mode is one of the
 * confirmed-dangerous ids — see `permission-mode.ts`'s own investigation
 * note) plus the mode name in mono, same discrete sizing as the last
 * round's model/effort styling pass otherwise.
 *
 * Escalating INTO a dangerous mode takes two clicks — the first arms an
 * inline "Confirm: agent acts without asking" row in place of that
 * option's normal name/description (`decideModeSelect`, pure); any other
 * pick (including a second click elsewhere) cancels the arm. De-escalating
 * to a non-dangerous mode is always one click. `useAnchorRect` is the same
 * shared hook `HarnessPicker`/`MetaOptionPicker` use — opens upward near
 * the composer automatically, nothing bespoke to solve here.
 */
export function PermissionModePicker({
  options,
  selectedId,
  onChange,
  iconOnly = false,
}: {
  options: PermissionModeOption[];
  selectedId: string | null;
  onChange: (id: string) => void;
  /**
   * Composer overlap round — drops the mono name label at low composer
   * widths (`composer-density.ts`), keeping just the shield icon +
   * chevron. Unlike effort (which disappears outright), a safety control
   * never vanishes silently — the icon (and its warning color when the
   * active mode is dangerous) always stays visible.
   */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rect = useAnchorRect(open, triggerRef, { estimatedHeight: options.length * 46 + 8, estimatedWidth: 220 });
  const selected = options.find((o) => o.id === selectedId) ?? null;
  const activeIsDangerous = selectedId !== null && isDangerousMode(selectedId);

  // Closing (however it happens) always disarms — a stale armed row must
  // never persist into the next time the dropdown opens.
  useEffect(() => {
    if (!open) setPendingConfirmId(null);
  }, [open]);

  const pick = (id: string) => {
    const decision = decideModeSelect(id, pendingConfirmId);
    if (decision.kind === 'confirm') {
      setPendingConfirmId(decision.modeId);
      return;
    }
    onChange(decision.modeId);
    setPendingConfirmId(null);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={iconOnly ? `Permission mode: ${selected?.name ?? 'unset'}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        className={cn(
          'hover:bg-bg-2 focus-visible:outline-accent flex w-fit shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-xs outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
          activeIsDangerous ? 'text-warning' : 'text-text-muted hover:text-text-primary'
        )}
      >
        {activeIsDangerous ? (
          <ShieldOff className="size-3 shrink-0" strokeWidth={1.5} />
        ) : (
          <ShieldCheck className="size-3 shrink-0" strokeWidth={1.5} />
        )}
        {!iconOnly && (
          <span className="max-w-28 truncate font-mono">{selected?.name ?? 'Mode'}</span>
        )}
        <ChevronDown className="size-2.5 shrink-0" strokeWidth={1.5} />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            role="listbox"
            style={{
              position: 'fixed',
              width: Math.max(rect.width, 220),
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
          >
            {options.map((option) => {
              const armed = pendingConfirmId === option.id;
              const dangerous = isDangerousMode(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={option.id === selectedId}
                  onMouseDown={(event) => {
                    // Same trick `HarnessPicker`/`MetaOptionPicker` use —
                    // keeps focus on the trigger so a plain click doesn't
                    // blur it and close the popup before this runs.
                    event.preventDefault();
                    pick(option.id);
                  }}
                  className={cn(
                    'block w-full px-2.5 py-1.5 text-left',
                    armed
                      ? 'bg-warning/10'
                      : option.id === selectedId
                        ? 'bg-bg-2'
                        : 'hover:bg-bg-2'
                  )}
                >
                  {armed ? (
                    <span className="text-warning text-xs font-medium">
                      Confirm: agent acts without asking
                    </span>
                  ) : (
                    <>
                      <span
                        className={cn(
                          'block truncate font-mono text-xs',
                          dangerous ? 'text-warning' : 'text-text-primary'
                        )}
                      >
                        {option.name}
                      </span>
                      {option.description && (
                        <span className="text-text-muted mt-0.5 block truncate text-xs">
                          {option.description}
                        </span>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
