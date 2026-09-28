import { BrowserWindow, type WebContents } from 'electron';
import { configureBrowserProfileSession } from '@main/core/browser/browser-profile-session';
import { cookieHostMatches, isSignInWall, type SignInSite } from '@shared/pages/sign-in-sites';
import { jarCookieToSet, type CookieToSet } from './chrome-sign-in';
import type { CheckResult } from './page-sign-ins';

/**
 * The check before a copied sign-in is kept (board 18, sheet step 3): the
 * cookies go into a throwaway in-memory browser profile first, the page is
 * loaded there in a hidden window, and only if it doesn't land on a sign-in
 * form are they written to the pages profile. So nothing half-copied ever
 * survives a refusal, a Cancel or a crash (cases 7 and 12).
 *
 * What's kept is the check profile's jar for the site's hosts after the
 * load, so a cookie the site rotated while checking comes across rotated.
 */

/** In-memory (no `persist:`), with the pages profile's hardening and user agent. */
const CHECK_PARTITION = 'rig-pages-sign-in-check';
const LOAD_TIMEOUT_MS = 25_000;
/** After the load, a moment for script redirects to a sign-in form. */
const SETTLE_MS = 1_500;

/** Whether a loaded page is a sign-in wall: its address, or a password field on it. */
export async function pageIsSignInWall(wc: WebContents): Promise<boolean> {
  const hasPasswordField = await wc
    .executeJavaScript(`!!document.querySelector('input[type="password"]')`, true)
    .then((v: unknown) => v === true)
    .catch(() => false);
  return isSignInWall({ url: wc.getURL(), hasPasswordField });
}

let queue: Promise<unknown> = Promise.resolve();

/** One check at a time: they share the one throwaway profile. */
export function checkSignIn(site: SignInSite, cookies: CookieToSet[], url: string, signal?: AbortSignal): Promise<CheckResult> {
  const run = queue.then(() => runCheck(site, cookies, url, signal));
  queue = run.catch(() => undefined);
  return run;
}

async function runCheck(site: SignInSite, cookies: CookieToSet[], url: string, signal?: AbortSignal): Promise<CheckResult> {
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  const ses = configureBrowserProfileSession(CHECK_PARTITION);
  await ses.clearStorageData();
  let win: BrowserWindow | null = null;
  try {
    for (const cookie of cookies) await ses.cookies.set(cookie).catch(() => {});
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.setAudioMuted(true);
    const loaded = await new Promise<'loaded' | 'cancelled' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), LOAD_TIMEOUT_MS);
      const onAbort = () => resolve('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      wc.once('did-stop-loading', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        setTimeout(() => resolve(signal?.aborted ? 'cancelled' : 'loaded'), SETTLE_MS);
      });
      // A redirect aborts the first load; did-stop-loading still follows.
      wc.loadURL(url).catch(() => {});
    });
    if (loaded === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (await pageIsSignInWall(wc)) return { ok: false, reason: 'rejected_by_site' };
    if (loaded === 'timeout' && !wc.getURL()) return { ok: false, reason: 'failed' };
    const kept = (await ses.cookies.get({}))
      .filter((c) => c.domain && cookieHostMatches(c.domain, site.hosts))
      .map((c) => jarCookieToSet(c))
      .filter((c): c is CookieToSet => c !== null);
    return kept.length > 0 ? { ok: true, cookies: kept } : { ok: false, reason: 'rejected_by_site' };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await ses.clearStorageData().catch(() => {});
  }
}
