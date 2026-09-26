import { BrowserWindow, type NativeImage, type Session, type WebContents } from 'electron';
import { configureBrowserProfileSession } from '@main/core/browser/browser-profile-session';
import { RIG_PAGES_PARTITION } from '@shared/spaces/links';

/**
 * The browser that pages open in: one session for the panel's `<webview>`s
 * and for agents' hidden tabs, so both see a site exactly as the person
 * signed into it. It's one of the app's browser profiles (same hardening:
 * deny-by-default permissions, the Google sign-in user agent), kept apart
 * from the general in-app browser.
 */
export const pagesSession = (): Session => configureBrowserProfileSession(RIG_PAGES_PARTITION);

/**
 * Agents read pages in hidden tabs of their own, never in the person's panel
 * (an agent must not move what someone is looking at). One tab per link,
 * reused across calls for a few minutes so a turn's several reads don't
 * reload the page each time.
 */
const IDLE_MS = 5 * 60_000;
const SETTLE_MS = 2_500;
const tabs = new Map<string, { win: BrowserWindow; ready: Promise<void>; timer: NodeJS.Timeout }>();

export async function agentPage(url: string): Promise<WebContents> {
  const existing = tabs.get(url);
  if (existing && !existing.win.isDestroyed()) {
    existing.timer.refresh();
    await existing.ready;
    return existing.win.webContents;
  }
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { session: pagesSession(), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const ready = win.loadURL(url).then(() => new Promise<void>((r) => setTimeout(r, SETTLE_MS)));
  const timer = setTimeout(() => {
    tabs.delete(url);
    if (!win.isDestroyed()) win.destroy();
  }, IDLE_MS);
  tabs.set(url, { win, ready, timer });
  await ready;
  return win.webContents;
}

/**
 * A board's static HTML rendered at its own size off-screen (scripts off), so
 * a screenshot is legible whatever zoom the canvas is at.
 */
export async function renderSnapshot(
  html: string,
  size: { w: number; h: number },
  crop?: { x: number; y: number; width: number; height: number } | null
): Promise<NativeImage> {
  const win = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(size.w)),
    height: Math.max(1, Math.round(size.h)),
    webPreferences: { offscreen: true, session: pagesSession(), javascript: false },
  });
  try {
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 900)); // web fonts
    if (!crop) return await win.webContents.capturePage();
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    return await win.webContents.capturePage({
      x,
      y,
      width: Math.max(1, Math.round(Math.min(crop.width, size.w - x))),
      height: Math.max(1, Math.round(Math.min(crop.height, size.h - y))),
    });
  } finally {
    win.destroy();
  }
}

export function closeAgentPages(): void {
  for (const { win, timer } of tabs.values()) {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
  tabs.clear();
}
