import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import type { LucideIcon } from 'lucide-react';

/**
 * Navigator v2 (`docs/file-navigator-design.md` §3.3): the tree row's
 * right-click context menu — "No hover button clutter" replaces the old
 * always-a-hover-pin-button/single-popover approach. Positioned at the
 * cursor rather than anchored to a trigger element, so it reuses
 * `use-anchor-rect.ts`'s pure `computeAnchorRect` (already unit-tested) fed
 * a zero-size "anchor" at the click point, rather than a second geometry
 * implementation — same viewport-flip behavior every other menu in this app
 * already has.
 */

export type ContextMenuPoint = { x: number; y: number };

/** One place to open/close a single context menu shared by every row in a tree — only one can ever be open at a time, so the state lives at the tree's root rather than per-row. */
export function useRowContextMenu<T>() {
  const [state, setState] = useState<{ point: ContextMenuPoint; target: T } | null>(null);
  const open = (event: React.MouseEvent, target: T) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ point: { x: event.clientX, y: event.clientY }, target });
  };
  const close = () => setState(null);
  return { state, open, close };
}

export function RowContextMenu({
  point,
  onClose,
  children,
}: {
  point: ContextMenuPoint;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = useMemo(
    () =>
      computeAnchorRect(
        { top: point.y, bottom: point.y, left: point.x, right: point.x, width: 0 },
        { width: window.innerWidth, height: window.innerHeight },
        { gap: 2, estimatedHeight: 220, estimatedWidth: 190, align: 'left' }
      ),
    [point]
  );

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        width: Math.max(rect.width, 190),
        maxHeight: rect.maxHeight,
        overflowY: 'auto',
        ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
        ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
      }}
      className="border-border-hairline bg-bg-1 rounded-control shadow-soft z-50 border py-1"
    >
      {children}
    </div>,
    document.body
  );
}

export function ContextMenuItem({
  label,
  icon: Icon,
  onSelect,
  danger = false,
}: {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
      className={
        danger
          ? 'hover:bg-bg-2 text-danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm'
          : 'hover:bg-bg-2 text-text-primary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm'
      }
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
      {label}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="bg-border-hairline my-1 h-px" />;
}
