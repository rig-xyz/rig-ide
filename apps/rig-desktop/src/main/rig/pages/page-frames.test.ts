import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { contentFrameOf, hitPage, locateOnPage, pageContentFrame } from './page-frames';
import type { PageAnchor } from '@shared/spaces/pages';

/**
 * Comments and pins spike (rig docs/comments-pins-spike.md). Both describes
 * fail today.
 *
 * Zoom: the panel sets a page's zoom with `setZoomFactor` (`page-zoom.ts`),
 * fitted to the panel (67% to 100%) until the person picks one. Inside a
 * zoomed page, CSS pixels are not the panel's pixels: in Electron 40 at 0.67,
 * an element the page reports at (400, 300) is drawn at (268, 201) in the
 * host (probe in the spike doc). `pinAt` and the pin buttons in
 * `page-view.tsx` use the panel's pixels as they are, so a click picks the
 * wrong element and pins are drawn away from theirs whenever zoom isn't 100%.
 */

const ZOOM = 0.67;

/** A panel page at `ZOOM` (relative to the app), with a top frame whose script answers `answer`. */
function zoomedPage(answer: unknown) {
  const executeJavaScript = vi.fn(async (_code: string) => answer);
  const page = {
    mainFrame: { executeJavaScript, frames: [], url: 'https://example.com/' },
    getZoomFactor: () => ZOOM,
    hostWebContents: { getZoomFactor: () => 1, isDestroyed: () => false },
  };
  return { page: page as unknown as WebContents, executeJavaScript };
}

const anchor: PageAnchor = { xo: [], hops: [], path: 'body:nth-of-type(1)>div:nth-of-type(1)', tag: 'div', text: 'pinned', fx: 0, fy: 0 };

describe('pins on a zoomed panel page', () => {
  it('looks under the click in the page’s own pixels', async () => {
    const { page, executeJavaScript } = zoomedPage({ hops: [], path: anchor.path, tag: 'div', text: 'pinned', fx: 0, fy: 0 });
    // The person clicks where the element is drawn in the panel.
    await hitPage(page, 268, 201);
    const code = executeJavaScript.mock.calls[0]![0];
    const point = JSON.parse(/\{"x":[^}]*\}/.exec(code)![0]) as { x: number; y: number };
    expect(point.x).toBeCloseTo(268 / ZOOM, 0);
    expect(point.y).toBeCloseTo(201 / ZOOM, 0);
  });

  it('places the pin where the element is drawn in the panel', async () => {
    const { page } = zoomedPage({ found: true, how: 'path', x: 400, y: 300, w: 100, h: 50 });
    const place = await locateOnPage(page, anchor);
    expect(place.found).toBe(true);
    expect(place.x).toBeCloseTo(400 * ZOOM, 0);
    expect(place.y).toBeCloseTo(300 * ZOOM, 0);
    expect(place.w).toBeCloseTo(100 * ZOOM, 0);
  });
});

/**
 * `contentFrameOf` picks the first cross-origin http(s) child of the top
 * frame as "the page's content", which is right for claude.ai's artifact
 * frame but also takes an ordinary page's embedded video, map or form.
 * `rig_browser_read` then reads that embed instead of the page, and
 * `rig_browser_screenshot` looks for pins' boards in it.
 */
describe('which frame agents read', () => {
  it('reads an ordinary page that embeds a video as the page itself', () => {
    const embed = { url: 'https://www.youtube.com/embed/abc123', frames: [] };
    const top = { url: 'https://blog.example.com/launch-notes', frames: [embed] };
    const page = { mainFrame: top } as unknown as WebContents;
    expect(contentFrameOf(page).frame).toBe(top);
  });

  it("reads claude.ai's artifact frame as the page's content", () => {
    const art = { url: 'https://abc.claudeusercontent.com/frame', frames: [] };
    const top = { url: 'https://claude.ai/public/artifacts/xyz', frames: [art] };
    const page = { mainFrame: top } as unknown as WebContents;
    expect(contentFrameOf(page)).toEqual({ frame: art, hop: { origin: 'https://abc.claudeusercontent.com', index: 0 } });
  });

  it('reads a cross-origin frame that fills most of the page as its content', async () => {
    const app = { url: 'https://app.example.net/view', frames: [] };
    const fills = [{ origin: 'https://app.example.net', share: 0.9 }];
    const top = { url: 'https://wrapper.example.com/', frames: [app], executeJavaScript: async () => fills };
    const page = { mainFrame: top } as unknown as WebContents;
    expect((await pageContentFrame(page)).frame).toBe(app);
    fills[0]!.share = 0.2;
    expect((await pageContentFrame(page)).frame).toBe(top);
  });
});
