import type { WebContents, WebFrameMain } from 'electron';
import { frameCall, framePin, type FrameHit, type FrameLocate, type PageAnchor } from './page-frame-scripts';

/**
 * Main-process side of page pins: walks a page's frames across origins,
 * running the frame scripts in each. Works on any page's WebContents: the
 * panel's `<webview>` for people, a hidden tab for agents.
 */

const run = <T>(frame: WebFrameMain, op: 'hit' | 'locate' | 'xoFrame', arg: unknown): Promise<T> =>
  frame.executeJavaScript(frameCall(framePin, op, arg)) as Promise<T>;

function childOf(frame: WebFrameMain, hop: { origin: string; index: number }): WebFrameMain | undefined {
  return frame.frames.filter((f) => {
    try {
      return new URL(f.url).origin === hop.origin;
    } catch {
      return false;
    }
  })[hop.index];
}

/** An anchor for whatever is at (x, y) in the page's viewport, or null. */
export async function hitPage(page: WebContents, x: number, y: number): Promise<PageAnchor | null> {
  let frame = page.mainFrame;
  const xo: PageAnchor['xo'] = [];
  for (let depth = 0; depth < 4; depth++) {
    const r = await run<FrameHit>(frame, 'hit', { x, y });
    if (!r) return null;
    if (!r.crossOrigin) return { xo, ...r };
    const child = childOf(frame, r.crossOrigin);
    if (!child) return null;
    xo.push(r.crossOrigin);
    frame = child;
    x = r.x;
    y = r.y;
  }
  return null;
}

export interface PagePlace {
  found: boolean;
  why?: string;
  /** The pin's point, and the element's size, in the page's viewport. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Where an anchor is now, in the page's viewport. */
export async function locateOnPage(page: WebContents, anchor: PageAnchor): Promise<PagePlace> {
  let frame = page.mainFrame;
  const geos: { left: number; top: number; sx: number; sy: number }[] = [];
  for (const hop of anchor.xo) {
    const g = await run<{ left: number; top: number; sx: number; sy: number } | null>(frame, 'xoFrame', hop);
    const child = childOf(frame, hop);
    if (!g || !child) return { found: false, why: 'frame gone' };
    geos.push(g);
    frame = child;
  }
  const r = await run<FrameLocate | null>(frame, 'locate', anchor);
  if (!r || !r.found) return r ?? { found: false };
  let { x = 0, y = 0, w = 0, h = 0 } = r;
  for (let i = geos.length - 1; i >= 0; i--) {
    const g = geos[i]!;
    x = g.left + x * g.sx;
    y = g.top + y * g.sy;
    w *= g.sx;
    h *= g.sy;
  }
  return { found: true, x, y, w, h };
}

/**
 * The frame holding a page's content: the first cross-origin child of the
 * top frame (claude.ai's claudeusercontent frame), else the top frame itself.
 */
export function contentFrameOf(page: WebContents): { frame: WebFrameMain; hop: { origin: string; index: number } | null } {
  const top = page.mainFrame;
  let topOrigin: string | null = null;
  try {
    topOrigin = new URL(top.url).origin;
  } catch {}
  const child = top.frames.find((f) => {
    try {
      return f.url.startsWith('http') && new URL(f.url).origin !== topOrigin;
    } catch {
      return false;
    }
  });
  return child ? { frame: child, hop: { origin: new URL(child.url).origin, index: 0 } } : { frame: top, hop: null };
}

/** Maps a point in the content frame to the page's viewport. */
export async function contentToPage(page: WebContents, rect: { x: number; y: number; width: number; height: number }) {
  const { hop } = contentFrameOf(page);
  if (!hop) return rect;
  const g = await run<{ left: number; top: number; sx: number; sy: number } | null>(page.mainFrame, 'xoFrame', hop);
  if (!g) return rect;
  return { x: g.left + rect.x * g.sx, y: g.top + rect.y * g.sy, width: rect.width * g.sx, height: rect.height * g.sy };
}
