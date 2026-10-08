import { BrowserWindow, type NativeImage, type Session, type WebContents } from 'electron';
import { configureBrowserProfileSession } from '@main/core/browser/browser-profile-session';
import { RIG_PAGES_PARTITION } from '@shared/spaces/links';
import { isRigFileUrl, RIG_FILES_PARTITION } from '@shared/spaces/rig-file';
import { installRigFileProtocol } from './rig-file-session';

/**
 * The browser that pages open in: one session for the panel's `<webview>`s
 * and for agents' hidden tabs, so both see a site exactly as the person
 * signed into it. It's one of the app's browser profiles (same hardening:
 * deny-by-default permissions, the Google sign-in user agent), kept apart
 * from the general in-app browser.
 */
export const pagesSession = (): Session => configureBrowserProfileSession(RIG_PAGES_PARTITION);

/**
 * Where a space's files open (`rig-file://`), for the panel and agents
 * alike: a profile of their own with no cookies or sign-ins from the pages
 * browser, so a file someone added to a space can't act as the person on
 * the web. Only this profile serves `rig-file://`.
 */
export const rigFilesSession = (): Session => {
  const ses = configureBrowserProfileSession(RIG_FILES_PARTITION);
  installRigFileProtocol(ses);
  return ses;
};

/** The session a page opens in, from its link. */
export const sessionForPage = (url: string): Session => (isRigFileUrl(url) ? rigFilesSession() : pagesSession());

/** Whether a session is one that pages open in: the pages browser or the space files' own. */
export const isPagesBrowserSession = (ses: unknown): boolean => ses === pagesSession() || ses === rigFilesSession();

/**
 * Agents read pages in hidden tabs of their own, never in the person's panel
 * (an agent must not move what someone is looking at). One tab per link,
 * reused across calls for a few minutes so a turn's several reads don't
 * reload the page each time.
 */
const IDLE_MS = 5 * 60_000;
const SETTLE_MS = 2_500;
const tabs = new Map<string, { win: BrowserWindow; ready: Promise<void>; timer: NodeJS.Timeout }>();

/** A load, plus a moment for the page's scripts to draw. */
function settled(load: Promise<void>): Promise<void> {
  return load.then(() => new Promise<void>((r) => setTimeout(r, SETTLE_MS)));
}

export async function agentPage(url: string): Promise<WebContents> {
  const existing = tabs.get(url);
  if (existing && !existing.win.isDestroyed()) {
    existing.timer.refresh();
    // A space's file may have just changed: read it as it is now.
    if (isRigFileUrl(url)) existing.ready = existing.ready.then(() => settled(existing.win.loadURL(url)));
    await existing.ready;
    return existing.win.webContents;
  }
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { session: sessionForPage(url), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const ready = settled(win.loadURL(url));
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
 * a screenshot is legible whatever zoom the canvas is at. `pageUrl` is the
 * page the board came from: a space file's board renders in that file's
 * profile too.
 */
export async function renderSnapshot(
  html: string,
  size: { w: number; h: number },
  crop?: { x: number; y: number; width: number; height: number } | null,
  pageUrl?: string
): Promise<NativeImage> {
  const win = new BrowserWindow({
    show: false,
    width: Math.max(1, Math.round(size.w)),
    height: Math.max(1, Math.round(size.h)),
    webPreferences: { offscreen: true, session: pageUrl ? sessionForPage(pageUrl) : pagesSession(), javascript: false },
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
