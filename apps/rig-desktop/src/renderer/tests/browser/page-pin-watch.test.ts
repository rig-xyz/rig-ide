import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameCall, frameWatch } from '@main/rig/pages/page-frame-scripts';

/**
 * The page watcher behind event-driven pins, run in a real browser page the
 * way main injects it (from `frameCall`'s string): it logs its marker when
 * the page scrolls (any scroller), resizes or changes, throttled, and
 * watches same-origin child frames (a canvas's boards) too.
 */

const EVERY = 40;
let marker: string;
let debug: ReturnType<typeof vi.spyOn>;
const signals = () => debug.mock.calls.filter((c: unknown[]) => c[0] === marker).length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Runs the injected source as a page script, like `executeJavaScript` does. */
const inject = (): boolean => {
  const w = window as unknown as { __rigWatchResult?: boolean };
  const script = document.createElement('script');
  script.textContent = `window.__rigWatchResult = ${frameCall(frameWatch, marker, EVERY)};`;
  document.head.appendChild(script);
  script.remove();
  return w.__rigWatchResult === true;
};

let root: HTMLDivElement;

beforeEach(() => {
  marker = `rig-pin-moved:test${Math.random().toString(16).slice(2)}`;
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  root = document.createElement('div');
  root.innerHTML = '<div id="scroller" style="height:100px;overflow:auto"><div style="height:1000px">tall</div></div><p id="p">hello</p>';
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
  debug.mockRestore();
});

describe('frameWatch', () => {
  it('says "moved" when any scroller scrolls, and when the page changes', async () => {
    expect(inject()).toBe(true);
    await wait(EVERY + 10);
    const before = signals();
    root.querySelector('#scroller')!.scrollTop = 300;
    await wait(EVERY + 20);
    expect(signals()).toBeGreaterThan(before);
    const afterScroll = signals();
    root.querySelector('#p')!.setAttribute('style', 'transform:translateX(10px)');
    await wait(EVERY + 20);
    expect(signals()).toBeGreaterThan(afterScroll);
  });

  it('is quiet while nothing happens', async () => {
    inject();
    await wait(EVERY + 10);
    const settled = signals();
    await wait(EVERY * 4);
    expect(signals()).toBe(settled);
  });

  it('throttles a burst to one now and one at the end of the window', async () => {
    inject();
    await wait(EVERY * 2);
    const before = signals();
    const p = root.querySelector('#p')!;
    for (let i = 0; i < 20; i++) {
      p.textContent = `hello ${i}`;
      await Promise.resolve();
    }
    await wait(EVERY * 3);
    const burst = signals() - before;
    expect(burst).toBeGreaterThanOrEqual(1);
    expect(burst).toBeLessThanOrEqual(2);
  });

  it('is injected once per frame (a second injection with the same marker does nothing)', () => {
    expect(inject()).toBe(true);
    expect(inject()).toBe(false);
  });

  it('watches a same-origin child frame (a canvas board) too', async () => {
    const frame = document.createElement('iframe');
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve();
      frame.srcdoc = '<div id="s" style="height:80px;overflow:auto"><div style="height:800px">board</div></div>';
      root.appendChild(frame);
    });
    inject();
    await wait(EVERY * 2);
    const before = signals();
    frame.contentDocument!.querySelector('#s')!.scrollTop = 200;
    await wait(EVERY + 20);
    expect(signals()).toBeGreaterThan(before);
  });
});
