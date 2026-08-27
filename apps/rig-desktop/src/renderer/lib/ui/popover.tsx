import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { cn } from '@renderer/lib/utils';

/**
 * THE floating-surface primitive (charter v2, slice 1). Before this file
 * the app carried ten hand-rolled copies of the same popover — each its own
 * portal, its own outside-click/Escape wiring, its own positioning, none
 * with keyboard traversal and none with motion. Ten copies is why arrow
 * keys worked in the composer's pickers and silently nowhere else, and why
 * no menu ever animated: there was no single place to fix.
 *
 * One primitive, two anchor shapes:
 *   - a trigger element (`anchor: RefObject`) — dropdowns, pickers, bells;
 *   - a point (`anchor: {x,y}`) — right-click context menus.
 *
 * What every consumer now gets for free:
 *   - viewport-aware flip on both axes via `computeAnchorRect`, with the
 *     REAL measured height replacing the estimate once the popup is on
 *     screen (the fix for menus near the bottom edge clipping);
 *   - outside-pointerdown + Escape dismissal, and focus returned to the
 *     trigger on close;
 *   - enter motion (`popover-in`, 150ms, gated in tokens.css) — exits are
 *     instant by design: leaving should never make the user wait;
 *   - `shadow-float` elevation (charter v2: menus float, cards do not);
 *   - when `role="menu"`: ArrowUp/Down roving focus over the menu items,
 *     Home/End, Enter/Space activation — the composer pickers' keyboard
 *     behavior, finally extracted to where every menu inherits it.
 */

import type { ContextMenuPoint } from './popover-types';

export type PopoverAnchor = React.RefObject<HTMLElement | null> | ContextMenuPoint;

function anchorBox(anchor: PopoverAnchor): { top: number; bottom: number; left: number; right: number; width: number } | null {
  if ('current' in anchor) {
    const el = anchor.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
  }
  return { top: anchor.y, bottom: anchor.y, left: anchor.x, right: anchor.x, width: 0 };
}

export function Popover({
  anchor,
  open,
  onClose,
  children,
  role = 'menu',
  align = 'left',
  gap = 4,
  estimatedWidth = 200,
  minWidth = 190,
  className,
  ariaLabel,
}: {
  anchor: PopoverAnchor;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** `menu` gets roving arrow-key focus over its items; anything else (e.g. `dialog` for rich popovers) manages its own. */
  role?: 'menu' | 'dialog' | 'listbox';
  align?: 'left' | 'right';
  gap?: number;
  estimatedWidth?: number;
  minWidth?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  /**
   * Two-pass placement: estimate first so something can render, then the
   * real scrollHeight replaces it and the flip decision is recomputed. A
   * grown menu can never outlive a stale guess and clip at the viewport
   * edge — the bug that shipped twice before this primitive existed.
   */
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const box = useMemo(() => (open ? anchorBox(anchor) : null), [open, anchor]);
  const rect = useMemo(() => {
    if (!box) return null;
    return computeAnchorRect(
      box,
      { width: window.innerWidth, height: window.innerHeight },
      { gap, estimatedHeight: measuredHeight ?? 320, estimatedWidth, align }
    );
  }, [box, gap, measuredHeight, estimatedWidth, align]);

  useLayoutEffect(() => {
    if (!open) return;
    const height = popRef.current?.scrollHeight;
    if (height && height !== measuredHeight) setMeasuredHeight(height);
  }, [open, measuredHeight, children]);
  useEffect(() => {
    if (!open) setMeasuredHeight(null);
  }, [open]);

  // Dismissal + focus return. The trigger (for ref anchors) regains focus on
  // close so keyboard users are never dropped onto <body>.
  useEffect(() => {
    if (!open) return;
    const returnTo = 'current' in anchor ? anchor.current : null;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target)) return;
      if (returnTo?.contains(target)) return; // the trigger's own click toggles; don't double-fire
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        returnTo?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, anchor]);

  // Roving focus for menus: items are focusable-but-not-tabbable buttons;
  // arrows move focus, Enter/Space activate the focused one natively.
  useEffect(() => {
    if (!open || role !== 'menu') return;
    const pop = popRef.current;
    if (!pop) return;
    const items = () =>
      Array.from(pop.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'));
    const first = items()[0];
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const list = items();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        list[(current + 1) % list.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        list[(current - 1 + list.length) % list.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        list[list.length - 1]?.focus();
      } else if (event.key === 'Tab') {
        onClose();
      }
    };
    pop.addEventListener('keydown', onKeyDown);
    return () => pop.removeEventListener('keydown', onKeyDown);
  }, [open, role, onClose]);

  if (!open || !rect) return null;

  return createPortal(
    <div
      ref={popRef}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        width: Math.max(rect.width, minWidth),
        maxHeight: rect.maxHeight,
        overflowY: 'auto',
        // Motion round: the entrance scales from the anchored corner, not
        // the center — popovers should grow out of their trigger.
        transformOrigin: `${rect.placement === 'below' ? 'top' : 'bottom'} ${rect.align}`,
        ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
        ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
      }}
      className={cn(
        'border-border-hairline bg-bg-1 rounded-control shadow-float popover-in z-50 border py-1',
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
}

/** A menu row: icon + label, focusable for the roving arrows, activates on click or Enter/Space (native button). */
export function PopoverMenuItem({
  label,
  icon: Icon,
  onSelect,
  danger = false,
  disabled = false,
  role = 'menuitem',
  selected,
}: {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  /** For radio/checkbox roles: reflected as aria-checked. */
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      disabled={disabled}
      aria-checked={role === 'menuitem' ? undefined : selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-sm transition-colors',
        'focus-visible:bg-bg-2 outline-none',
        danger ? 'hover:bg-bg-2 text-danger' : 'hover:bg-bg-2 text-text-primary',
        disabled && 'text-text-muted pointer-events-none'
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />}
      {label}
    </button>
  );
}

export function PopoverSeparator() {
  return <div className="bg-border-hairline my-1 h-px" />;
}
