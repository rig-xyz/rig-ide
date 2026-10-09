import type { WebContents, WebFrameMain } from 'electron';
import type { PageAnchor, PagePlace } from '@shared/spaces/pages';
import { frameCall, framePin, type FrameHit, type FrameLocate } from './page-frame-scripts';

export type { PagePlace } from '@shared/spaces/pages';

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

/**
 * How many panel pixels one of the page's CSS pixels takes. The panel zooms
 * a page with `setZoomFactor` (`page-zoom.ts`), relative to its host's zoom,
 * so the panel's points are divided by this on the way in and the page's
 * places multiplied by it on the way out. 1 for a tab with no host.
 */
export function pageScale(page: WebContents): number {
  try {
    const own = page.getZoomFactor?.() ?? 1;
    const host = page.hostWebContents && !page.hostWebContents.isDestroyed() ? page.hostWebContents.getZoomFactor() : 1;
    const scale = own / host;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  } catch {
    return 1;
  }
}

/** An anchor for whatever is at (x, y) in the panel's pixels, or null. */
export async function hitPage(page: WebContents, x: number, y: number): Promise<PageAnchor | null> {
  const scale = pageScale(page);
  x /= scale;
  y /= scale;
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

/** Where an anchor is now, in the panel's pixels. */
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
  const scale = pageScale(page);
  return { found: true, x: x * scale, y: y * scale, w: w * scale, h: h * scale };
}

/** Pages that keep their content one cross-origin frame down: claude.ai's claudeusercontent frame. */
const CONTENT_IN_FRAME_HOSTS = /(^|\.)claude\.ai$/;

/**
 * The frame holding a page's content: on a known host (claude.ai), its first
 * cross-origin child; on any other page, a cross-origin child whose origin is
 * in `filling` (one that fills most of the page, from `pageContentFrame`);
 * else the top frame itself. So an ordinary page with an embedded video or
 * map is read as the page.
 */
export function contentFrameOf(
  page: WebContents,
  filling: readonly string[] = []
): { frame: WebFrameMain; hop: { origin: string; index: number } | null } {
  const top = page.mainFrame;
  let topOrigin: string | null = null;
  let known = false;
  try {
    const u = new URL(top.url);
    topOrigin = u.origin;
    known = CONTENT_IN_FRAME_HOSTS.test(u.hostname);
  } catch {}
  const child = top.frames.find((f) => {
    try {
      if (!f.url.startsWith('http')) return false;
      const origin = new URL(f.url).origin;
      return origin !== topOrigin && (known || filling.includes(origin));
    } catch {
      return false;
    }
  });
  if (!child) return { frame: top, hop: null };
  const origin = new URL(child.url).origin;
  const index = top.frames.filter((f) => {
    try {
      return new URL(f.url).origin === origin;
    } catch {
      return false;
    }
  }).indexOf(child);
  return { frame: child, hop: { origin, index } };
}

/** Share of the viewport a frame must cover to count as the page's content. */
const FILLS_PAGE = 0.6;

/** `contentFrameOf`, also taking a cross-origin frame that fills most of the page as its content. */
export async function pageContentFrame(page: WebContents): Promise<ReturnType<typeof contentFrameOf>> {
  const code = `[...document.querySelectorAll('iframe')].map((f) => {
    const r = f.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    let origin = null;
    try { origin = new URL(f.src, location.href).origin; } catch {}
    return { origin, share: (w * h) / Math.max(1, innerWidth * innerHeight) };
  })`;
  const frames = ((await page.mainFrame.executeJavaScript(code).catch(() => [])) ?? []) as { origin: string | null; share: number }[];
  return contentFrameOf(page, frames.filter((f) => f.origin && f.share >= FILLS_PAGE).map((f) => f.origin!));
}

/** Maps a point in the content frame to the page's viewport. */
export async function contentToPage(page: WebContents, rect: { x: number; y: number; width: number; height: number }) {
  const { hop } = contentFrameOf(page);
  if (!hop) return rect;
  const g = await run<{ left: number; top: number; sx: number; sy: number } | null>(page.mainFrame, 'xoFrame', hop);
  if (!g) return rect;
  return { x: g.left + rect.x * g.sx, y: g.top + rect.y * g.sy, width: rect.width * g.sx, height: rect.height * g.sy };
}
