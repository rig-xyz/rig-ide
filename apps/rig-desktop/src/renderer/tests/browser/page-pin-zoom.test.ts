import { afterEach, describe, expect, it } from 'vitest';
import { frameCall, framePin, type PageAnchor } from '@main/rig/pages/page-frame-scripts';

/**
 * A pin follows its element when the page's zoom changes. The panel zooms a
 * page with `setZoomFactor`: at zoom z, a panel of width W lays the page out
 * W / z CSS pixels wide and draws each CSS pixel z panel pixels wide.
 * `hitPage` divides the panel's point by z and `locateOnPage` multiplies the
 * place by it (`pageScale`); here a frame sized W / z stands in for the
 * zoomed page, and the frame scripts run inside it from `frameCall`'s source,
 * as they do in a page.
 *
 * The page is a space's tiny HTML file: its body fills the viewport and
 * centres the content, and the click is on the blank space beside it.
 */
const PANEL = { w: 600, h: 400 };
const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px serif }
  main { text-align: center; padding: 2rem } h1 { font-size: 3rem; margin: 0 0 .5rem } p { margin: 0 }
</style></head><body><main><h1>warm-island</h1><p>A tiny page, served from a shared Rig space.</p></main></body></html>`;

let frame: HTMLIFrameElement;
afterEach(() => frame?.remove());

async function open(): Promise<HTMLIFrameElement> {
  frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:0;top:0;border:0';
  zoom(1);
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    frame.srcdoc = PAGE;
    document.body.appendChild(frame);
  });
  return frame;
}

/** The page at zoom `z` in the panel: its viewport in CSS pixels. */
function zoom(z: number) {
  frame.style.width = `${PANEL.w / z}px`;
  frame.style.height = `${PANEL.h / z}px`;
}

const inPage = <T,>(source: string): T => (frame.contentWindow as unknown as { Function: FunctionConstructor }).Function(`return ${source}`)() as T;
/** `hitPage`: the panel's point in the page's pixels. */
const hit = (x: number, y: number, z: number) => inPage<PageAnchor>(frameCall(framePin, 'hit', { x: x / z, y: y / z }));
/** `locateOnPage`: where the pin is drawn, in the panel's pixels. */
const pinAt = (a: PageAnchor, z: number) => {
  const r = inPage<{ found: boolean; x: number; y: number }>(frameCall(framePin, 'locate', a));
  return { found: r.found, x: r.x * z, y: r.y * z };
};
/** The content's box in the panel's pixels. */
const contentAt = (z: number) => {
  const r = frame.contentDocument!.querySelector('main')!.getBoundingClientRect();
  return { left: r.left * z, top: r.top * z, width: r.width * z, height: r.height * z };
};

describe('a pin when the page zooms', () => {
  it('follows the content it was made beside, at any zoom', async () => {
    await open();
    const before = contentAt(1);
    // The blank space left of the content, about where pin 1 was made.
    const click = { x: before.left - 40, y: before.top + 10 };
    const a = hit(click.x, click.y, 1);
    expect(a.tag).not.toBe('body');
    expect(pinAt(a, 1)).toMatchObject({ found: true, x: expect.closeTo(click.x, 0), y: expect.closeTo(click.y, 0) });

    for (const z of [0.33, 0.67, 1.5]) {
      zoom(z);
      const now = contentAt(z);
      const pin = pinAt(a, z);
      expect(pin.found).toBe(true);
      // Same place relative to the content, the gap scaled with the zoom.
      expect(pin.x).toBeCloseTo(now.left - 40 * (now.width / before.width), 0);
      expect(pin.y).toBeCloseTo(now.top + 10 * (now.height / before.height), 0);
    }
  });

  it('stays on an element it was made on', async () => {
    await open();
    const h1 = frame.contentDocument!.querySelector('h1')!.getBoundingClientRect();
    const a = hit(h1.left + h1.width / 2, h1.top + h1.height / 2, 1);
    expect(a).toMatchObject({ tag: 'h1', text: 'warm-island' });
    zoom(0.33);
    const now = frame.contentDocument!.querySelector('h1')!.getBoundingClientRect();
    const pin = pinAt(a, 0.33);
    expect(pin.x).toBeCloseTo((now.left + now.width / 2) * 0.33, 0);
    expect(pin.y).toBeCloseTo((now.top + now.height / 2) * 0.33, 0);
  });
});
