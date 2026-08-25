import { useState } from 'react';
import { Popover, PopoverMenuItem, PopoverSeparator } from '@renderer/lib/ui/popover';
import type { ContextMenuPoint } from '@renderer/lib/ui/popover-types';

/**
 * The tree's right-click / row-`⋯` menu, now a thin skin over the shared
 * `Popover` primitive (charter v2 slice 1) — which is where the measured
 * flip, dismissal, entrance motion, and the arrow-key traversal this menu
 * never had all live now. This file keeps only what is genuinely the
 * tree's own: one menu shared by every row, opened either at the pointer
 * (right-click) or at a point the caller measured (the `⋯` button).
 */

export type { ContextMenuPoint };

/** One place to open/close a single context menu shared by every row in a tree — only one can ever be open at a time, so the state lives at the tree's root rather than per-row. */
export function useRowContextMenu<T>() {
  const [state, setState] = useState<{ point: ContextMenuPoint; target: T } | null>(null);
  const open = (event: React.MouseEvent, target: T) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ point: { x: event.clientX, y: event.clientY }, target });
  };
  const openAt = (point: ContextMenuPoint, target: T) => setState({ point, target });
  const close = () => setState(null);
  return { state, open, openAt, close };
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
  return (
    <Popover anchor={point} open onClose={onClose} role="menu" gap={2} estimatedWidth={190}>
      {children}
    </Popover>
  );
}

export const ContextMenuItem = PopoverMenuItem;
export const ContextMenuSeparator = PopoverSeparator;
