import type { WebContents } from 'electron';
import { pageZoomKeyOf, type PageZoomKey } from '@shared/pages/page-zoom';

/**
 * A panel page's zoom, main side (`@shared/pages/page-zoom` has the why).
 * The panel asks for a factor relative to the app's own zoom; the page gets
 * that times the app window's zoom, so 100% always reads at the app's scale
 * and the app's ⌘+ doesn't leave a page zoomed in.
 */

/** The parts of a panel page's WebContents this uses (a fake in tests). */
export type ZoomedContents = Pick<WebContents, 'id' | 'isDestroyed' | 'setZoomFactor' | 'on' | 'off' | 'once'> & {
  hostWebContents?: Pick<WebContents, 'getZoomFactor' | 'isDestroyed'> | null;
};

export function applyPageZoom(wc: ZoomedContents, factor: number): void {
  const host = wc.hostWebContents && !wc.hostWebContents.isDestroyed() ? wc.hostWebContents.getZoomFactor() : 1;
  wc.setZoomFactor(factor * host);
}

const watching = new Set<number>();

/** Forwards the page's zoom keys and Ctrl-scroll zoom to `onKey` (once per page), instead of the menu zooming its host. */
export function watchZoomKeys(wc: ZoomedContents, onKey: (key: PageZoomKey) => void, isMac = process.platform === 'darwin'): void {
  if (watching.has(wc.id)) return;
  watching.add(wc.id);
  const onInput = (event: { preventDefault(): void }, input: Parameters<typeof pageZoomKeyOf>[0]) => {
    const key = pageZoomKeyOf(input, isMac);
    if (!key) return;
    event.preventDefault();
    onKey(key);
  };
  const onWheelZoom = (_event: unknown, direction: 'in' | 'out') => onKey(direction);
  wc.on('before-input-event', onInput as never);
  wc.on('zoom-changed', onWheelZoom as never);
  wc.once('destroyed', (() => {
    wc.off('before-input-event', onInput as never);
    wc.off('zoom-changed', onWheelZoom as never);
    watching.delete(wc.id);
  }) as never);
}
