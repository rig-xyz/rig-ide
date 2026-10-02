import { useCallback, type CSSProperties } from 'react';

/**
 * The divider between the chat and the panel beside it (a file, a page).
 * Drag it to resize, double-click it for the default split.
 *
 * The drag starts from the chat's width as drawn (not the stored one, which
 * a narrow window may be capping), so the divider follows the pointer from
 * the first pixel instead of sitting still through a dead zone. The hit
 * area reaches a few px past the hairline on both sides, over the page too:
 * a page is a `<webview>`, which would otherwise take the pointer at its
 * edge, and while dragging every webview lets the pointer through.
 *
 * In a space the divider runs up under the bare top bar to the window's top
 * edge (`topbarChrome` in App.tsx). The hairline is drawn just above the bar
 * (z 31 over its z 30), so the bar's blur never fades it; the grab area
 * stays below the bar, which keeps its strip as the window's drag region.
 */

/** The handle's own width, and its hit area beyond that, each side. Inline (not classes) so they hold wherever the styles do. */
const HANDLE_PX = 8;
const REACH_PX = 6;

export function clampChatWidth(width: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, width));
}

export function ChatDivider({
  style,
  measure,
  onResize,
  onResizeEnd,
  onReset,
  direction = 1,
}: {
  style?: CSSProperties;
  /** The chat's width as drawn now, and the bounds a drag may take it to. */
  measure: () => { width: number; min: number; max: number };
  /** Each frame of a drag. */
  onResize: (width: number) => void;
  /** The drag's last width (persist it). */
  onResizeEnd: (width: number) => void;
  /** Double-click: back to the default split. */
  onReset: () => void;
  /** 1 when the chat is left of the divider (dragging right widens it), -1 when right. */
  direction?: 1 | -1;
}) {
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const { width: startWidth, min, max } = measure();
      const startX = event.clientX;
      let latestWidth = startWidth;
      let moved = false;
      let frame = 0;
      const views = Array.from(document.querySelectorAll<HTMLElement>('webview'));
      for (const view of views) view.style.pointerEvents = 'none';
      document.body.style.cursor = 'col-resize';
      const commit = () => {
        frame = 0;
        onResize(latestWidth);
      };
      const onMove = (moveEvent: PointerEvent) => {
        moved = true;
        latestWidth = clampChatWidth(startWidth + direction * (moveEvent.clientX - startX), min, max);
        if (!frame) frame = requestAnimationFrame(commit);
      };
      const onUp = () => {
        if (frame) cancelAnimationFrame(frame);
        for (const view of views) view.style.pointerEvents = '';
        document.body.style.cursor = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        // A click (no move) changes nothing and stores nothing.
        if (!moved) return;
        onResize(latestWidth);
        onResizeEnd(latestWidth);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [measure, onResize, onResizeEnd, direction]
  );

  return (
    <div
      style={{ position: 'relative', width: HANDLE_PX, ...style }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      title="Drag to resize · double-click to reset"
      className="group shrink-0 cursor-col-resize"
      data-testid="chat-divider"
    >
      <div
        // The grab area: wider than the hairline, over both neighbours.
        style={{ position: 'absolute', top: 0, bottom: 0, left: -REACH_PX, right: -REACH_PX, cursor: 'col-resize', zIndex: 20 }}
        onPointerDown={onPointerDown}
        onDoubleClick={onReset}
        data-testid="chat-divider-grab"
      />
      <div
        data-testid="chat-divider-line"
        className="pointer-events-none absolute inset-y-0 left-1/2 z-[31] w-px -translate-x-1/2 bg-border-hairline transition-[width,background-color] duration-100 group-hover:w-[3px] group-hover:rounded-full group-hover:bg-accent/60 group-active:w-[3px] group-active:bg-accent"
      />
    </div>
  );
}
