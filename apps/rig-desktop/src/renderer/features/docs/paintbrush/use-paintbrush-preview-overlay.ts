import { useLayoutEffect, useRef } from 'react';
import type { PositionIndex } from '../preview/position-index';
import { createPaintbrushPreviewPainter } from './paintbrush-preview-highlight';
import type { PaintbrushOverlay } from './paintbrush-decorations';

/**
 * Preview's counterpart to `use-paintbrush-editor-sync.ts` — paints the same
 * overlay via the CSS Custom Highlight API instead of a CM6 decoration.
 * `active` gates every paint (false while Edit mode is showing, or
 * paintbrush-disabled types), mirroring `use-preview-comments.ts`'s own
 * `active` gate for the identical reason: never fight the other surface for
 * the highlight registry.
 */
export function usePaintbrushPreviewOverlay({
  active,
  getIndex,
  overlay,
}: {
  active: boolean;
  getIndex: () => PositionIndex | null;
  overlay: PaintbrushOverlay | null;
}): void {
  const painterRef = useRef<ReturnType<typeof createPaintbrushPreviewPainter> | null>(null);
  if (painterRef.current === null) painterRef.current = createPaintbrushPreviewPainter(getIndex);
  const painter = painterRef.current;

  useLayoutEffect(() => {
    painter.paint(active && overlay ? [overlay] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, overlay?.from, overlay?.to, overlay?.streaming, overlay?.ready, painter]);

  useLayoutEffect(() => () => painter.dispose(), [painter]);
}
