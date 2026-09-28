import { useSyncExternalStore } from 'react';
import type { AutoSignInOutcome } from '@main/rig/pages/page-sign-ins';
import { rpc } from '@renderer/lib/ipc';
import type { AutoSignInReason, BrowserId } from '@shared/pages/sign-in-sites';

/**
 * A page the person opened, signed in automatically from the connected
 * Chrome profile (board 18, revised): what the page's chip shows while it
 * happens and after. Main decides and rate-limits (`rig.pages.autoSignIn`);
 * this only asks for the page that loaded, and asks again (`retry`) only on
 * the person's own action: Connect finishing, coming back from Chrome, Try
 * again. A page loading on its own never retries, so nothing loops.
 */

export type AutoState =
  | { phase: 'signing' }
  | { phase: 'failed'; reason: AutoSignInReason; browser?: BrowserId; watching?: 'waiting' | 'checking' | 'gave-up' };

/** The page of each site open in the panel: where a retry goes. */
interface PanelPage {
  webContentsId: number;
  pageUrl: string;
}

/** Chrome can take ~30s to save a new sign-in: after coming back, look a few more times. */
export const CHROME_WATCH_RETRY_MS = 10_000;
export const CHROME_WATCH_RETRIES = 4;

/** Reasons that aren't the person's to act on: the chip stays as it was. */
const QUIET: ReadonlySet<AutoSignInReason> = new Set(['not_connected', 'rate_limited', 'keychain_would_prompt', 'not_a_panel_page', 'cancelled']);

const states = new Map<string, AutoState>();
const pages = new Map<string, PanelPage>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function set(siteId: string, state: AutoState | null): void {
  if (state) states.set(siteId, state);
  else states.delete(siteId);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAutoSignIn(siteId: string | null | undefined): AutoState | undefined {
  return useSyncExternalStore(subscribe, () => (siteId ? states.get(siteId) : undefined));
}

export function getAutoState(siteId: string): AutoState | undefined {
  return states.get(siteId);
}

function stopWatch(siteId: string): void {
  const timer = timers.get(siteId);
  if (timer) clearTimeout(timer);
  timers.delete(siteId);
}

/**
 * Ask main to sign a panel page in. `retry` only for the person's action.
 * Resolves with main's answer (null when there is no panel page for the site).
 */
export async function runAutoSignIn(siteId: string, opts: { retry?: boolean } = {}): Promise<AutoSignInOutcome | null> {
  const page = pages.get(siteId);
  if (!page) return null;
  const before = states.get(siteId);
  if (before?.phase === 'signing') return null;
  set(siteId, { phase: 'signing' });
  const result = await rpc.rig.pages
    .autoSignIn({ webContentsId: page.webContentsId, pageUrl: page.pageUrl, ...(opts.retry ? { retry: true } : {}) })
    .catch((): AutoSignInOutcome => ({ ok: false, reason: 'failed' }));
  if (result.ok) set(siteId, null);
  else if (QUIET.has(result.reason)) set(siteId, before?.phase === 'failed' ? before : null);
  else set(siteId, { phase: 'failed', reason: result.reason, ...(result.browser ? { browser: result.browser } : {}) });
  return result;
}

/** "Open in Chrome" when Chrome isn't signed in to the site: opens the page there, and looks again when the person is back (case 5). */
export async function openInChromeAndWatch(siteId: string, url: string, browser?: BrowserId): Promise<void> {
  await rpc.rig.pages.openInBrowser({ url, ...(browser ? { browser } : {}) }).catch(() => {});
  const state = states.get(siteId);
  if (state?.phase === 'failed' && state.reason === 'not_signed_in_in_browser') set(siteId, { ...state, watching: 'waiting' });
}

async function lookAgain(siteId: string, left: number): Promise<void> {
  stopWatch(siteId);
  const state = states.get(siteId);
  if (state?.phase !== 'failed' || state.reason !== 'not_signed_in_in_browser') return;
  const result = await runAutoSignIn(siteId, { retry: true });
  if (!result || result.ok) return;
  const now = states.get(siteId);
  if (now?.phase !== 'failed' || now.reason !== 'not_signed_in_in_browser') return;
  if (left <= 0) {
    set(siteId, { ...now, watching: 'gave-up' });
    return;
  }
  set(siteId, { ...now, watching: 'checking' });
  timers.set(
    siteId,
    setTimeout(() => void lookAgain(siteId, left - 1), CHROME_WATCH_RETRY_MS)
  );
}

/** Rig's window has focus again: pick up a sign-in made in Chrome meanwhile. */
export async function onAutoSignInFocus(): Promise<void> {
  for (const [siteId, state] of states) {
    if (state.phase === 'failed' && state.reason === 'not_signed_in_in_browser' && state.watching === 'waiting') await lookAgain(siteId, CHROME_WATCH_RETRIES);
  }
}

/** The person gave up on the automatic way ("Sign in here"): the chip goes quiet. */
export function clearAutoSignIn(siteId: string): void {
  stopWatch(siteId);
  set(siteId, null);
}

if (typeof window !== 'undefined') window.addEventListener('focus', () => void onAutoSignInFocus());

/** Tests only. */
export function resetAutoSignIn(): void {
  for (const id of [...timers.keys()]) stopWatch(id);
  states.clear();
  pages.clear();
  for (const l of listeners) l();
}

/** The panel page of a site, as it loads: the one an automatic sign-in (and its retries) is for. */
export function registerPanelPage(siteId: string, page: PanelPage): () => void {
  pages.set(siteId, page);
  return () => {
    if (pages.get(siteId) === page) pages.delete(siteId);
  };
}
