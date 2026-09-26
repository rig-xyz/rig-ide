import { afterEach, describe, expect, it } from 'vitest';
import { frameBoards, frameBoardSnapshot, frameCall, framePin, type PageAnchor } from '@main/rig/pages/page-frame-scripts';

/**
 * The frame scripts run in a page from their serialized source
 * (`executeJavaScript(frameCall(...))`), so these tests run them the same
 * way: from `frameCall`'s string, never by calling the imports directly.
 * The stage mimics claude.ai's design canvas: same-origin srcdoc boards on a
 * pan/zoom world, with a transparent layer over each board.
 */
const inject = <T,>(source: string): T => new Function(`return ${source}`)() as T;

const board = (title: string, body: string) =>
  `<html><body style="margin:0;padding:20px;font:14px sans-serif"><h2 style="margin:0 0 10px">${title}</h2>${body}</body></html>`;

let world: HTMLDivElement;

async function stage(): Promise<HTMLIFrameElement[]> {
  world = document.createElement('div');
  // The test runner's viewport is small: start zoomed out so every board is on screen.
  world.style.cssText = `position:fixed;left:0;top:0;transform-origin:0 0;transform:scale(${Math.min(1, innerWidth / 960)})`;
  document.body.appendChild(world);
  const boards = [
    board('Q2 recap', '<p>Held at 312.</p>'),
    board('Q3 pipeline grew +41% QoQ', '<svg width="200" height="120"><rect x="10" y="40" width="30" height="80"/><rect x="60" y="10" width="30" height="110"/></svg>'),
    board('By quarter', '<table><tr><td>Q2</td><td>312</td></tr><tr><td>Q3</td><td>398</td></tr></table>'),
  ];
  const frames = await Promise.all(
    boards.map(
      (srcdoc, i) =>
        new Promise<HTMLIFrameElement>((resolve) => {
          const f = document.createElement('iframe');
          f.style.cssText = `position:absolute;border:1px solid #999;width:280px;height:240px;left:${20 + i * 300}px;top:20px`;
          f.onload = () => resolve(f);
          f.srcdoc = srcdoc;
          world.appendChild(f);
          // The canvas's own layer over each board, like claude.ai's.
          const layer = document.createElement('div');
          layer.style.cssText = `position:absolute;left:${20 + i * 300}px;top:20px;width:282px;height:242px`;
          world.appendChild(layer);
        })
    )
  );
  return frames;
}

function centreOf(f: HTMLIFrameElement, selector: string) {
  const el = f.contentDocument!.querySelector(selector)!;
  const fr = f.getBoundingClientRect();
  const s = fr.width / f.offsetWidth;
  const r = el.getBoundingClientRect();
  return { x: fr.left + (f.clientLeft + r.left + r.width / 2) * s, y: fr.top + (f.clientTop + r.top + r.height / 2) * s };
}

const hit = (x: number, y: number) => inject<PageAnchor>(frameCall(framePin, 'hit', { x, y }));
const locate = (a: PageAnchor) => inject<{ found: boolean; how?: string; x: number; y: number; w: number; h: number }>(frameCall(framePin, 'locate', a));
const centreFound = (a: PageAnchor) => {
  const l = locate(a);
  return { x: l.x - (a.fx - 0.5) * l.w, y: l.y - (a.fy - 0.5) * l.h };
};

afterEach(() => world?.remove());

describe('page pins', () => {
  it('pins the element under a click, looking beneath the layer the canvas puts over its boards', async () => {
    const frames = await stage();
    const c = centreOf(frames[1]!, 'h2');
    const a = hit(c.x, c.y);
    expect(a).toMatchObject({ tag: 'h2', text: 'Q3 pipeline grew +41% QoQ', hops: [{ index: 1 }] });
  });

  it('finds every pin again after panning and zooming the canvas', async () => {
    const frames = await stage();
    const targets = [
      [frames[1]!, 'h2'],
      [frames[1]!, 'rect:nth-of-type(2)'],
      [frames[2]!, 'tr:nth-of-type(2) td:nth-of-type(2)'],
    ] as const;
    const anchors = targets.map(([f, sel]) => hit(centreOf(f, sel).x, centreOf(f, sel).y));
    expect(anchors.map((a) => a.tag)).toEqual(['h2', 'rect', 'td']);

    world.style.transform = `translate(-20px, 10px) scale(${Math.min(1, innerWidth / 960) * 1.3})`;
    targets.forEach(([f, sel], i) => {
      const truth = centreOf(f, sel);
      const found = centreFound(anchors[i]!);
      expect(Math.hypot(found.x - truth.x, found.y - truth.y)).toBeLessThan(1);
    });
  });

  it('follows its board when content is added above the pin and the boards are reordered', async () => {
    const frames = await stage();
    const c = centreOf(frames[1]!, 'h2');
    const a = hit(c.x, c.y);
    const doc = frames[1]!.contentDocument!;
    const note = doc.createElement('p');
    note.textContent = 'Draft: numbers pending review.';
    doc.body.insertBefore(note, doc.body.firstChild);
    // Reorder: move the chart board to the front. Moving an iframe reloads
    // it, so re-apply the edit after it reloads, like an author's edit.
    const reloaded = new Promise((r) => (frames[1]!.onload = r));
    world.insertBefore(frames[1]!, world.firstChild);
    await reloaded;
    const d2 = frames[1]!.contentDocument!;
    const p2 = d2.createElement('p');
    p2.textContent = 'Draft: numbers pending review.';
    d2.body.insertBefore(p2, d2.body.firstChild);
    const l = locate(a);
    expect(l).toMatchObject({ found: true });
    const truth = centreOf(frames[1]!, 'h2');
    const found = centreFound(a);
    expect(Math.hypot(found.x - truth.x, found.y - truth.y)).toBeLessThan(1);
  });

  it('says a pin is gone when its element no longer exists', async () => {
    const frames = await stage();
    const c = centreOf(frames[2]!, 'tr:nth-of-type(2) td:nth-of-type(2)');
    const a = hit(c.x, c.y);
    frames[2]!.contentDocument!.querySelector('tr:nth-of-type(2)')!.remove();
    expect(locate(a)).toMatchObject({ found: false, why: 'element gone' });
  });
});

describe('boards for agents', () => {
  it('lists boards with their titles, and snapshots one with where an element sits in it', async () => {
    const frames = await stage();
    const boards = inject<{ i: number; title: string }[]>(frameCall(frameBoards, false));
    expect(boards.map((b) => [b.i, b.title.slice(0, 12)])).toEqual([
      [0, 'Q2 recap Hel'],
      [1, 'Q3 pipeline '],
      [2, 'By quarter Q'],
    ]);
    const snap = inject<{ i: number; html: string; w: number; el: { width: number } | null }>(
      frameCall(frameBoardSnapshot, { words: 'By quarter', text: '398' })
    );
    expect(snap.i).toBe(2);
    expect(snap.w).toBe(frames[2]!.clientWidth);
    expect(snap.html).toContain('398');
    expect(snap.html).not.toContain('<script');
    expect(snap.el?.width).toBeGreaterThan(0);
  });
});
