import { describe, expect, it, vi } from 'vitest';
import { applyPageZoom, watchZoomKeys, type ZoomedContents } from './page-zoom';

function fakePage(id: number, hostZoom = 1) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const wc = {
    id,
    isDestroyed: () => false,
    setZoomFactor: vi.fn(),
    hostWebContents: { getZoomFactor: () => hostZoom, isDestroyed: () => false },
    on: (event: string, cb: (...args: unknown[]) => void) => ((handlers[event] ??= []).push(cb), wc),
    off: (event: string, cb: (...args: unknown[]) => void) => ((handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb)), wc),
    once: (event: string, cb: (...args: unknown[]) => void) => ((handlers[event] ??= []).push(cb), wc),
  };
  const fire = (event: string, ...args: unknown[]) => (handlers[event] ?? []).forEach((h) => h(...args));
  return { wc: wc as unknown as ZoomedContents & { setZoomFactor: ReturnType<typeof vi.fn> }, fire, handlers };
}

describe('panel page zoom (main)', () => {
  it("sets the page's zoom relative to the app's, so the app's own ⌘+ never leaves a page zoomed in", () => {
    const plain = fakePage(1);
    applyPageZoom(plain.wc, 0.8);
    expect(plain.wc.setZoomFactor).toHaveBeenCalledWith(0.8);
    const zoomedApp = fakePage(2, 1.5);
    applyPageZoom(zoomedApp.wc, 1);
    expect(zoomedApp.wc.setZoomFactor).toHaveBeenCalledWith(1.5);
  });

  it("takes the page's ⌘+/⌘−/⌘0 from the menu (which would zoom the whole host) and hands them to the panel, with Ctrl-scroll", () => {
    const page = fakePage(3);
    const keys: string[] = [];
    watchZoomKeys(page.wc, (key) => keys.push(key), true);
    watchZoomKeys(page.wc, (key) => keys.push(`again:${key}`), true); // once per page

    const zoomIn = { preventDefault: vi.fn() };
    page.fire('before-input-event', zoomIn, { type: 'keyDown', key: '=', meta: true });
    expect(zoomIn.preventDefault).toHaveBeenCalled();
    const typing = { preventDefault: vi.fn() };
    page.fire('before-input-event', typing, { type: 'keyDown', key: 'a', meta: false });
    expect(typing.preventDefault).not.toHaveBeenCalled();
    page.fire('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '0', meta: true });
    page.fire('zoom-changed', {}, 'out');
    expect(keys).toEqual(['in', 'reset', 'out']);

    // Gone with the page: the listeners come off, and a new page by that id is watched afresh.
    page.fire('destroyed');
    expect(page.handlers['before-input-event']).toEqual([]);
    expect(page.handlers['zoom-changed']).toEqual([]);
  });
});
