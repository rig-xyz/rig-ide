import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserConnection, PageSignInRecord } from '@shared/pages/sign-in-sites';

/**
 * Signing pages in (canvas board 18, revised: connect Chrome once, then
 * automatic per page), renderer side: the page header's chip and its menus,
 * the banner, the Connect sheet, automatic sign-in on open, the per-site
 * sheet's error states and exits, and Settings › Sign-ins. Main is a mock:
 * no browser data anywhere. That agents can't trigger any of it is main's
 * (`panel-page.test.ts`).
 */

type Access = { id: 'chrome' | 'arc'; name: string; folder: 'granted' | 'denied' | 'unknown'; keychain: 'unknown' | 'granted' | 'silent' };

const state = vi.hoisted(() => ({
  sites: [] as PageSignInRecord[],
  keepInStep: false,
  browsers: [] as Access[],
  connection: null as BrowserConnection | null,
}));

const pages = vi.hoisted(() => ({
  signIns: vi.fn(),
  signInOptions: vi.fn(),
  signIn: vi.fn(),
  refreshSignIn: vi.fn(),
  cancelSignIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  setKeepInStep: vi.fn(async () => {}),
  openPrivacySettings: vi.fn(async () => {}),
  openInBrowser: vi.fn(async () => {}),
  connectOptions: vi.fn(),
  connect: vi.fn(),
  cancelConnect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  autoSignIn: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { rig: { pages } },
  events: { on: vi.fn(() => () => {}) },
}));

import { AccountChip, SignInBanner } from '@renderer/features/pages/account-chip';
import { CHROME_WATCH_RETRY_MS, registerPanelPage, resetAutoSignIn, runAutoSignIn } from '@renderer/features/pages/auto-sign-in';
import { resetConnectFlow } from '@renderer/features/pages/connect-flow';
import { ConnectSheet } from '@renderer/features/pages/connect-sheet';
import { SignInRows } from '@renderer/features/pages/sign-in';
import { resetSignInFlows, signInFlow, WATCH_RETRY_MS } from '@renderer/features/pages/sign-in-flow';
import { NotSharedNotice } from '@renderer/features/pages/not-shared-notice';
import { SignInSheet } from '@renderer/features/pages/sign-in-sheet';
import { signInSiteForUrl } from '@shared/pages/sign-in-sites';

const DOC = 'https://docs.google.com/document/d/abc/edit';
const google = signInSiteForUrl(DOC)!;
const NOTION = 'https://www.notion.so/Roadmap-123';
const notion = signInSiteForUrl(NOTION)!;

const personal = { browser: 'chrome' as const, browserName: 'Chrome', dir: 'Default', name: 'Personal', email: 'me@example.test', lastUsedAt: Date.now() - 2 * 3_600_000 };
const work = { browser: 'chrome' as const, browserName: 'Chrome', dir: 'Profile 2', name: 'Work', email: 'you@work.example', lastUsedAt: Date.now() - 3 * 86_400_000 };

function record(over: Partial<PageSignInRecord> = {}): PageSignInRecord {
  return {
    site: 'google.com',
    siteName: 'Google',
    browser: 'chrome',
    browserName: 'Chrome',
    profile: 'Default',
    profileName: 'Personal',
    account: 'me@example.test',
    hosts: google.hosts,
    checkUrl: DOC,
    importedAt: 1,
    sourceUpdatedAt: 1,
    ...over,
  };
}

const options = (profiles: (typeof personal)[]) => ({ ok: true, site: google, browsers: [{ id: 'chrome', name: 'Chrome' }], profiles, denied: [] });
const connectOptions = (profiles: (typeof personal)[], browsers = [{ id: 'chrome', name: 'Chrome' }]) => ({ ok: true, browsers, profiles, denied: [] });
const CONNECTED: BrowserConnection = { browser: 'chrome', browserName: 'Chrome', profile: 'Default', profileName: 'Personal', email: 'me@example.test', connectedAt: 1 };
const WHERE = 'page:test';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const onSignInHere = vi.fn();
const onDismiss = vi.fn();

beforeEach(() => {
  resetSignInFlows();
  resetConnectFlow();
  resetAutoSignIn();
  state.sites = [];
  state.keepInStep = false;
  state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'unknown', keychain: 'unknown' }];
  state.connection = null;
  for (const fn of Object.values(pages)) fn.mockClear();
  pages.signIns.mockImplementation(async () => ({ sites: state.sites, keepInStep: state.keepInStep, browsers: state.browsers, connection: state.connection }));
  pages.connectOptions.mockReset().mockResolvedValue(connectOptions([work, personal]));
  pages.connect.mockReset().mockImplementation(async (input: { profile: string }) => {
    const c = input.profile === 'Profile 2' ? { ...CONNECTED, profile: 'Profile 2', profileName: 'Work', email: 'you@work.example' } : CONNECTED;
    state.connection = c;
    return { ok: true, connection: c };
  });
  pages.autoSignIn.mockReset().mockImplementation(async () => {
    state.sites = [record()];
    return { ok: true, record: record() };
  });
  pages.signInOptions.mockReset().mockResolvedValue(options([personal, work]));
  pages.signIn.mockReset().mockImplementation(async (input: { profile: string }) => {
    const r = record(input.profile === 'Profile 2' ? { profile: 'Profile 2', profileName: 'Work', account: 'you@work.example' } : {});
    state.sites = [r];
    return { ok: true, record: r };
  });
  pages.refreshSignIn.mockReset().mockImplementation(async () => ({ ok: true, record: record({ importedAt: 2 }) }));
  onSignInHere.mockClear();
  onDismiss.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A page: header chip, banner, the page itself, and the sheet over it. */
async function renderPage(site = google, url = DOC, opts: { wall?: boolean; dismissed?: boolean } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <div style={{ position: 'relative', width: 800, height: 600 }}>
          <AccountChip site={site} pageUrl={url} where={WHERE} onSignInHere={onSignInHere} />
          <SignInBanner site={site} pageUrl={url} where={WHERE} wall={opts.wall ?? false} dismissed={opts.dismissed ?? false} onDismiss={onDismiss} />
          <button type="button" data-testid="page-content">
            the page
          </button>
          <SignInSheet siteId={site.id} onSignInHere={onSignInHere} />
          <ConnectSheet where={WHERE} />
        </div>
      </QueryClientProvider>
    );
  });
  await settle();
}

const chip = () => document.querySelector<HTMLElement>('[data-testid="account-chip"]')!;
const sheet = () => document.querySelector<HTMLElement>('[data-testid="sign-in-sheet"]');
const step = () => sheet()?.dataset.step ?? null;
const connectSheet = () => document.querySelector<HTMLElement>('[data-testid="connect-sheet"]');
const connectStep = () => connectSheet()?.dataset.step ?? null;

function button(text: string | RegExp): HTMLElement {
  const all = Array.from(document.querySelectorAll<HTMLElement>('button, [role="menuitem"]'));
  const found = all.find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));
  if (!found) throw new Error(`No button "${String(text)}" in: ${all.map((b) => b.textContent?.trim()).join(' | ')}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await settle();
}

const menuTexts = () => Array.from(document.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent?.trim());

describe('the account chip', () => {
  it('not connected: offers to connect Chrome, signing in here, and the page in the browser', async () => {
    await renderPage(notion, NOTION);
    expect(chip().dataset.state).toBe('signed-out');
    expect(chip().textContent).toBe('Not signed in');
    await click(chip());
    expect(menuTexts()).toEqual(['Connect Chrome…', 'Sign in here', 'Open in Chrome']);
    expect(document.body.textContent).toContain('Agents see them only as you, only while a turn runs.');
    await click(button('Open in Chrome'));
    expect(pages.openInBrowser).toHaveBeenCalledWith({ url: NOTION });
    await click(chip());
    await click(button('Sign in here'));
    expect(onSignInHere).toHaveBeenCalledOnce();
  });

  it('without any Chromium browser: no browser option, "Open in browser" instead', async () => {
    state.browsers = [];
    await renderPage();
    await click(chip());
    expect(menuTexts()).toEqual(['Sign in here', 'Open in browser']);
  });

  it('names another Chromium browser when that is what is installed', async () => {
    state.browsers = [{ id: 'arc', name: 'Arc', folder: 'unknown', keychain: 'unknown' }];
    await renderPage();
    await click(chip());
    expect(menuTexts()[0]).toBe('Connect Arc…');
  });

  it('connected but not signed in to the site yet: "Sign in with Chrome" asks main, as the person\'s action', async () => {
    state.connection = CONNECTED;
    registerPanelPage('google.com', { webContentsId: 7, pageUrl: DOC });
    await renderPage();
    await click(chip());
    expect(menuTexts()).toEqual(['Sign in with Chrome', 'Sign in here', 'Open in Chrome']);
    await click(button('Sign in with Chrome'));
    expect(pages.autoSignIn).toHaveBeenCalledWith({ webContentsId: 7, pageUrl: DOC, retry: true });
  });

  it('signed in: shows the account, where it came from, switch / refresh / sign out in rig', async () => {
    state.sites = [record()];
    await renderPage();
    expect(chip().dataset.state).toBe('signed-in');
    expect(chip().textContent).toContain('me@example.test');
    await click(chip());
    expect(document.body.textContent).toContain('From Chrome · Personal');
    expect(menuTexts()).toEqual(['Switch account…', 'Refresh from Chrome', 'Sign out of Google in rig']);
    await click(button('Sign out of Google in rig'));
    expect(pages.signOut).toHaveBeenCalledWith({ site: 'google.com' });
  });

  it('expired: reads "Signed out" and offers a refresh', async () => {
    state.sites = [record({ expired: true })];
    await renderPage(google, DOC, { wall: true });
    expect(chip().textContent).toBe('Signed out');
    expect(document.querySelector('[data-testid="sign-in-banner"]')?.textContent).toContain('Your Google sign-in in rig has expired.');
    await click(button('Refresh from Chrome'));
    expect(pages.refreshSignIn).toHaveBeenCalledWith({ site: 'google.com' });
    expect(step()).toBe('done');
  });
});

describe('the sign-in-wall banner', () => {
  it('not connected, on a sign-in wall: "Connect Chrome to open pages as you", Connect, then this page is signed in', async () => {
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
    pages.connectOptions.mockResolvedValue(connectOptions([personal]));
    registerPanelPage('google.com', { webContentsId: 7, pageUrl: DOC });
    await renderPage(google, DOC, { wall: true });
    const banner = document.querySelector('[data-testid="sign-in-banner"]')!;
    expect(banner.textContent).toContain('Connect Chrome to open pages as you.');
    await click(banner.querySelector<HTMLElement>('[aria-label="Hide for this page"]')!);
    expect(onDismiss).toHaveBeenCalled();
    await click(button('Connect'));
    // Already allowed, one profile: straight to connecting, then this page, as the person's action.
    expect(pages.connect).toHaveBeenCalledWith({ browser: 'chrome', profile: 'Default' });
    expect(connectStep()).toBe('done');
    expect(pages.autoSignIn).toHaveBeenCalledWith({ webContentsId: 7, pageUrl: DOC, retry: true });
  });

  it('connected and never signed in: no banner (the automatic sign-in and the chip handle it)', async () => {
    state.connection = CONNECTED;
    await renderPage(google, DOC, { wall: true });
    expect(document.querySelector('[data-testid="sign-in-banner"]')).toBeNull();
  });

  it('stays away when dismissed, or when there is no wall', async () => {
    await renderPage(google, DOC, { wall: true, dismissed: true });
    expect(document.querySelector('[data-testid="sign-in-banner"]')).toBeNull();
    await renderPage(google, DOC, { wall: false });
    expect(document.querySelector('[data-testid="sign-in-banner"]')).toBeNull();
  });
});

// The per-site sheet: still how an automatic sign-in's errors, a refresh and a
// switch of account for one site are walked through.
describe('the per-site sheet', () => {
  it('first time: hosts → macOS heads-up → profiles listed → pick → checking → done', async () => {
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    expect(step()).toBe('share');
    expect(document.querySelector('[data-testid="sign-in-hosts"]')?.textContent).toBe('docs.google.comaccounts.google.comgoogle.com');
    // Listing profiles would make macOS ask before the heads-up: not yet.
    expect(pages.signInOptions).not.toHaveBeenCalled();
    await click(button('Continue'));
    expect(step()).toBe('heads-up');
    expect(sheet()!.textContent).toContain('macOS will check with you, twice');
    expect(document.querySelector('[data-testid="heads-up-folder"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="heads-up-keychain"]')?.textContent).toContain('Chrome Safe Storage');
    await click(button('Continue'));
    expect(pages.signInOptions).toHaveBeenCalledWith({ site: 'google.com', pageUrl: DOC });
    expect(step()).toBe('share');
    const profiles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="sign-in-profile"]'));
    expect(profiles.map((p) => p.textContent)).toEqual([expect.stringContaining('Personal'), expect.stringContaining('Work')]);
    expect(profiles[0]!.textContent).toContain('used 2h ago');
    await click(profiles[1]!);
    await click(button('Continue'));
    expect(pages.signIn).toHaveBeenCalledWith({ site: 'google.com', browser: 'chrome', profile: 'Profile 2', pageUrl: DOC });
    expect(step()).toBe('done');
    expect(sheet()!.textContent).toContain("You're in as you@work.example");
    await click(document.querySelector<HTMLElement>('[data-testid="keep-in-step"]')!);
    expect(pages.setKeepInStep).toHaveBeenCalledWith({ on: true });
    await click(button('Done'));
    expect(sheet()).toBeNull();
  });

  it('skips the heads-up once macOS allowed rig and the Keychain answers without asking, and the choice with one profile', async () => {
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
    pages.signInOptions.mockResolvedValue(options([personal]));
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    expect(document.querySelector('[data-testid="sign-in-only-profile"]')?.textContent).toBe('From Chrome · Personal (me@example.test)');
    await click(button('Continue'));
    expect(pages.signIn).toHaveBeenCalledOnce();
    expect(step()).toBe('done');
  });

  it('shows only the Keychain part of the heads-up when folder access is already granted', async () => {
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'granted' }];
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    await click(button('Continue'));
    expect(step()).toBe('heads-up');
    expect(sheet()!.textContent).toContain('macOS will check with you');
    expect(sheet()!.textContent).not.toContain('twice');
    expect(document.querySelector('[data-testid="heads-up-folder"]')).toBeNull();
  });

  it('Back returns to the first step', async () => {
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    await click(button('Continue'));
    await click(button('Back'));
    expect(step()).toBe('share');
  });
});

describe('abandoning the sheet', () => {
  it('Not now leaves the page usable and signed out; the chip picks up where it was left (case 1)', async () => {
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    await click(button('Continue'));
    expect(step()).toBe('heads-up');
    await click(button('Not now'));
    expect(sheet()).toBeNull();
    expect(pages.signIn).not.toHaveBeenCalled();
    await click(document.querySelector<HTMLElement>('[data-testid="page-content"]')!);
    expect(chip().dataset.state).toBe('unfinished');
    expect(chip().textContent).toBe('Finish signing in');
    await click(chip());
    expect(step()).toBe('heads-up');
  });

  it('Esc and ✕ close it the same way', async () => {
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await settle();
    expect(sheet()).toBeNull();
    await click(chip());
    await click(sheet()!.querySelector<HTMLElement>('[aria-label="Close"]')!);
    expect(sheet()).toBeNull();
    expect(chip().textContent).toBe('Finish signing in');
  });

  it('Cancel while checking stops main, writes nothing, and a late answer changes nothing (case 12)', async () => {
    let finish!: (v: unknown) => void;
    pages.signIn.mockImplementation(() => new Promise((r) => (finish = r)));
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    await click(profilesButton(1));
    await click(button('Continue'));
    expect(step()).toBe('verifying');
    expect(sheet()!.textContent).toContain('Signing you in…');
    await click(button('Cancel'));
    expect(pages.cancelSignIn).toHaveBeenCalledWith({ site: 'google.com' });
    expect(sheet()).toBeNull();
    await act(async () => finish({ ok: true, record: record() }));
    await settle();
    expect(sheet()).toBeNull();
    expect(chip().textContent).toBe('Finish signing in');
    await click(chip());
    expect(step()).toBe('share');
  });

  it('Sign in here drops the flow and hands the page back', async () => {
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    pages.signInOptions.mockResolvedValue({ ok: false, reason: 'folder_access_denied', browser: 'chrome' });
    await settle();
    await click(button('Continue'));
    await click(button('Continue'));
    await click(button('Sign in here'));
    expect(onSignInHere).toHaveBeenCalledOnce();
    expect(sheet()).toBeNull();
    expect(chip().dataset.state).toBe('signed-out');
  });
});

function profilesButton(i: number): HTMLElement {
  return document.querySelectorAll<HTMLElement>('[data-testid="sign-in-profile"]')[i]!;
}

async function toError(result: unknown, from: 'options' | 'sign-in') {
  state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
  if (from === 'options') pages.signInOptions.mockResolvedValue(result);
  else {
    pages.signInOptions.mockResolvedValue(options([personal]));
    pages.signIn.mockResolvedValue(result);
  }
  await renderPage();
  await act(async () => void signInFlow.start(google, DOC));
  await settle();
  if (from === 'sign-in') await click(button('Continue'));
  const error = document.querySelector<HTMLElement>('[data-testid="sign-in-error"]');
  expect(error).not.toBeNull();
  return error!;
}

describe('the error states and their ways out', () => {
  it("macOS said Don't Allow: says where, opens System Settings, and retries when rig is focused again (case 2)", async () => {
    const error = await toError({ ok: false, reason: 'folder_access_denied', browser: 'chrome' }, 'options');
    expect(error.dataset.reason).toBe('folder_access_denied');
    expect(error.textContent).toContain('Privacy & Security › Files & Folders › Rig › Google Chrome');
    await click(button('Open System Settings'));
    expect(pages.openPrivacySettings).toHaveBeenCalledOnce();
    pages.signInOptions.mockResolvedValue(options([personal]));
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await settle();
    expect(pages.signIn).toHaveBeenCalledOnce();
    expect(step()).toBe('done');
  });

  it('Keychain denied: Try again reads again (case 4)', async () => {
    const error = await toError({ ok: false, reason: 'keychain_denied', browser: 'chrome' }, 'sign-in');
    expect(error.textContent).toContain("macOS didn't hand over Chrome's key");
    expect(error.textContent).toContain('Always Allow');
    pages.signIn.mockResolvedValue({ ok: true, record: record() });
    await click(button('Try again'));
    expect(pages.signIn).toHaveBeenCalledTimes(2);
    expect(step()).toBe('done');
  });

  it("the site refused the copy: Sign in here is first, nothing retries on its own (case 7)", async () => {
    const error = await toError({ ok: false, reason: 'rejected_by_site', browser: 'chrome' }, 'sign-in');
    expect(error.textContent).toContain("Google didn't accept your Chrome sign-in in rig");
    expect(Array.from(error.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Sign in here', 'Open in Chrome', 'Try again']);
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await settle();
    expect(pages.signIn).toHaveBeenCalledOnce();
    await click(button('Open in Chrome'));
    expect(pages.openInBrowser).toHaveBeenCalledWith({ url: DOC });
  });

  it('not signed in in Chrome: opens it there and checks again on return, a few times while Chrome saves (case 5)', async () => {
    const error = await toError(options([]), 'options');
    expect(error.textContent).toContain('Sign in to Google in Chrome first');
    await click(button('Open in Chrome'));
    expect(pages.openInBrowser).toHaveBeenCalledWith({ url: DOC });
    expect(sheet()!.textContent).toContain('Sign in there, then come back');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pages.signInOptions).toHaveBeenCalledTimes(2);
    // Chrome hasn't saved it yet; the next look finds it.
    pages.signInOptions.mockResolvedValue(options([personal]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCH_RETRY_MS);
    });
    vi.useRealTimers();
    await settle();
    expect(pages.signInOptions).toHaveBeenCalledTimes(3);
    expect(pages.signIn).toHaveBeenCalledOnce();
    expect(step()).toBe('done');
  });

  it('no browser at all: sign in here or open in the browser', async () => {
    state.browsers = [];
    await renderPage();
    await act(async () => void signInFlow.start(google, DOC));
    await settle();
    const error = document.querySelector<HTMLElement>('[data-testid="sign-in-error"]')!;
    expect(error.dataset.reason).toBe('no_browser');
    expect(Array.from(error.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Sign in here', 'Open in browser']);
  });
});

describe('automatic sign-in on open', () => {
  beforeEach(() => {
    state.connection = CONNECTED;
    registerPanelPage('google.com', { webContentsId: 7, pageUrl: DOC });
  });

  it('a page loading asks once, without retry; the chip reads "Signing in with Chrome…", then the account', async () => {
    let finish!: (v: unknown) => void;
    pages.autoSignIn.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    await renderPage();
    await act(async () => void runAutoSignIn('google.com'));
    expect(pages.autoSignIn).toHaveBeenCalledWith({ webContentsId: 7, pageUrl: DOC });
    expect(chip().dataset.state).toBe('signing');
    expect(chip().textContent).toBe('Signing in with Chrome…');
    state.sites = [record()];
    await act(async () => finish({ ok: true, record: record() }));
    await act(async () => void queryClient.invalidateQueries());
    await settle();
    expect(chip().dataset.state).toBe('signed-in');
    expect(chip().textContent).toContain('me@example.test');
  });

  it('Chrome not signed in to the site: "Not signed in" with Open in Chrome (looked at again on return) and Sign in here', async () => {
    pages.autoSignIn.mockResolvedValue({ ok: false, reason: 'not_signed_in_in_browser', browser: 'chrome' });
    await renderPage();
    await act(async () => void runAutoSignIn('google.com'));
    await settle();
    expect(chip().textContent).toBe('Not signed in');
    await click(chip());
    expect(document.querySelector('[data-testid="not-in-chrome"]')?.textContent).toBe("Chrome · Personal isn't signed in to Google.");
    expect(menuTexts()).toEqual(['Open in Chrome', 'Sign in here']);
    await click(button('Open in Chrome'));
    expect(pages.openInBrowser).toHaveBeenCalledWith({ url: DOC, browser: 'chrome' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pages.autoSignIn).toHaveBeenLastCalledWith({ webContentsId: 7, pageUrl: DOC, retry: true });
    // Chrome saves it a little later: the next look finds it.
    pages.autoSignIn.mockResolvedValue({ ok: true, record: record() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHROME_WATCH_RETRY_MS);
    });
    vi.useRealTimers();
    expect(pages.autoSignIn).toHaveBeenCalledTimes(3);
  });

  it('Sign in here quiets it: the chip goes back to plain "Not signed in"', async () => {
    pages.autoSignIn.mockResolvedValue({ ok: false, reason: 'not_signed_in_in_browser', browser: 'chrome' });
    await renderPage();
    await act(async () => void runAutoSignIn('google.com'));
    await settle();
    await click(chip());
    await click(button('Sign in here'));
    expect(onSignInHere).toHaveBeenCalledOnce();
    await click(chip());
    expect(menuTexts()).toEqual(['Sign in with Chrome', 'Sign in here', 'Open in Chrome']);
  });

  it('the Keychain denied: "Couldn\'t sign in" opens the clear error, and Try again reads the connected profile', async () => {
    pages.autoSignIn.mockResolvedValue({ ok: false, reason: 'keychain_denied', browser: 'chrome' });
    await renderPage();
    await act(async () => void runAutoSignIn('google.com'));
    await settle();
    expect(chip().dataset.state).toBe('failed');
    await click(chip());
    const error = document.querySelector<HTMLElement>('[data-testid="sign-in-error"]')!;
    expect(error.dataset.reason).toBe('keychain_denied');
    await click(button('Try again'));
    expect(pages.signIn).toHaveBeenCalledWith({ site: 'google.com', browser: 'chrome', profile: 'Default', pageUrl: DOC });
    expect(step()).toBe('done');
  });

  it('the site refused the copy: the existing error, Sign in here first', async () => {
    pages.autoSignIn.mockResolvedValue({ ok: false, reason: 'rejected_by_site', browser: 'chrome' });
    await renderPage();
    await act(async () => void runAutoSignIn('google.com'));
    await settle();
    await click(chip());
    expect(document.querySelector('[data-testid="sign-in-error"]')?.textContent).toContain("Google didn't accept your Chrome sign-in in rig");
    await click(button('Sign in here'));
    expect(onSignInHere).toHaveBeenCalled();
  });

  it('rate-limited or would-prompt answers leave the chip quiet', async () => {
    pages.autoSignIn.mockResolvedValue({ ok: false, reason: 'rate_limited' });
    await renderPage();
    await act(async () => void runAutoSignIn('google.com'));
    await settle();
    expect(chip().dataset.state).toBe('signed-out');
    expect(chip().textContent).toBe('Not signed in');
  });
});

describe('Settings › Sign-ins', () => {
  async function renderSettings() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SignInRows />
        </QueryClientProvider>
      );
    });
    await settle();
  }

  const text = () => document.querySelector('[data-testid="settings-sign-ins"]')!.textContent ?? '';

  it('not connected: what it is for and one button, "Connect Chrome"; no URL field anywhere', async () => {
    await renderSettings();
    expect(text()).toContain('Use your Chrome sign-ins');
    expect(text()).toContain('Pages you open beside a chat open signed in as you. Rig copies only the site you open, when you open it.');
    expect(button('Connect Chrome')).toBeTruthy();
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('[data-testid="sign-in-sites"]')).toBeNull();
    expect(document.querySelector('[data-testid="keep-in-step"]')).toBeNull();
  });

  it('Connect Chrome: macOS heads-up → profile picker (several) → connected, inline', async () => {
    await renderSettings();
    await click(button('Connect Chrome'));
    expect(connectStep()).toBe('heads-up');
    expect(connectSheet()!.textContent).toContain('macOS will check with you, twice');
    // Listing profiles is what macOS asks about: not before Continue.
    expect(pages.connectOptions).not.toHaveBeenCalled();
    await click(button('Continue'));
    expect(connectStep()).toBe('pick');
    const profiles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="connect-profile"]'));
    expect(profiles.map((p) => p.textContent)).toEqual([expect.stringContaining('Work'), expect.stringContaining('Personal')]);
    expect(profiles[0]!.getAttribute('aria-checked')).toBe('true');
    await click(profiles[1]!);
    await click(button('Connect'));
    expect(pages.connect).toHaveBeenCalledWith({ browser: 'chrome', profile: 'Default' });
    expect(connectStep()).toBe('done');
    expect(connectSheet()!.textContent).toContain('Chrome connected');
    await click(button('Done'));
    expect(connectSheet()).toBeNull();
    expect(document.querySelector('[data-testid="sign-in-connection"]')?.textContent).toContain('Chrome · Personal · me@example.test');
  });

  it('Connect with several browsers installed offers a choice', async () => {
    state.browsers = [
      { id: 'chrome', name: 'Chrome', folder: 'unknown', keychain: 'unknown' },
      { id: 'arc', name: 'Arc', folder: 'unknown', keychain: 'unknown' },
    ];
    pages.connectOptions.mockResolvedValue(
      connectOptions([personal, { ...personal, browser: 'arc' as never, browserName: 'Arc', dir: 'Default', name: 'Arc profile' }], [
        { id: 'chrome', name: 'Chrome' },
        { id: 'arc', name: 'Arc' },
      ])
    );
    await renderSettings();
    await click(button('Connect Chrome'));
    await click(button('Arc'));
    await click(button('Continue'));
    // One Arc profile: straight to connecting it.
    expect(pages.connect).toHaveBeenCalledWith({ browser: 'arc', profile: 'Default' });
  });

  it('Connect: folder access refused → Open System Settings, retried when rig is focused again', async () => {
    pages.connectOptions.mockResolvedValue({ ok: false, reason: 'folder_access_denied', browser: 'chrome' });
    await renderSettings();
    await click(button('Connect Chrome'));
    await click(button('Continue'));
    const error = document.querySelector<HTMLElement>('[data-testid="connect-error"]')!;
    expect(error.dataset.reason).toBe('folder_access_denied');
    expect(error.textContent).toContain('Turn on Google Chrome under System Settings › Privacy & Security › Files & Folders › Rig');
    await click(button('Open System Settings'));
    expect(pages.openPrivacySettings).toHaveBeenCalledOnce();
    pages.connectOptions.mockResolvedValue(connectOptions([personal]));
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await settle();
    expect(pages.connect).toHaveBeenCalledOnce();
    expect(connectStep()).toBe('done');
  });

  it('Connect: Keychain denied → Try again; Not now keeps nothing', async () => {
    pages.connectOptions.mockResolvedValue(connectOptions([personal]));
    pages.connect.mockResolvedValueOnce({ ok: false, reason: 'keychain_denied', browser: 'chrome' });
    await renderSettings();
    await click(button('Connect Chrome'));
    await click(button('Continue'));
    expect(document.querySelector('[data-testid="connect-error"]')?.textContent).toContain("macOS didn't hand over Chrome's key");
    await click(button('Try again'));
    expect(pages.connect).toHaveBeenCalledTimes(2);
    expect(connectStep()).toBe('done');
    await click(button('Done'));
    await click(button('Change profile'));
    await click(button('Not now'));
    expect(connectSheet()).toBeNull();
  });

  it('connected: the profile with Change profile / Disconnect, sites signed in automatically with Remove, Keep in step', async () => {
    state.connection = CONNECTED;
    state.sites = [record(), record({ site: 'claude.ai', siteName: 'Claude', hosts: ['claude.ai'], expired: true, checkUrl: 'https://claude.ai/recents' })];
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
    await renderSettings();
    expect(text()).not.toContain('Use your Chrome sign-ins');
    expect(document.querySelector('[data-testid="sign-in-connection"]')?.textContent).toContain('Chrome · Personal · me@example.test');
    const list = document.querySelector<HTMLElement>('[data-testid="sign-in-sites"]')!;
    expect(list.textContent).toContain('Signed in automatically');
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-testid="sign-in-site"]'));
    expect(rows.map((r) => r.dataset.site)).toEqual(['google.com', 'claude.ai']);
    expect(rows[0]!.textContent).toContain('Google · me@example.test');
    expect(rows[1]!.textContent).toContain('expired');
    expect(rows[1]!.textContent).toContain('Refresh from Chrome');
    expect(document.querySelector('[data-testid="keep-in-step"]')).not.toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(text().trim().endsWith('Agents see these pages only as you, only while a turn runs.')).toBe(true);
    await click(Array.from(rows[0]!.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!);
    expect(pages.signOut).toHaveBeenCalledWith({ site: 'google.com' });
    await click(button('Disconnect'));
    expect(pages.disconnect).toHaveBeenCalledWith({});
  });

  it('names the browser to connect when Chrome is not installed', async () => {
    state.browsers = [{ id: 'arc', name: 'Arc', folder: 'unknown', keychain: 'unknown' }];
    await renderSettings();
    expect(text()).toContain('Use your Arc sign-ins');
    expect(button('Connect Arc')).toBeTruthy();
  });

  it('permission off: a clear warning with what to turn on, and the button', async () => {
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'denied', keychain: 'unknown' }];
    await renderSettings();
    const warning = document.querySelector<HTMLElement>('[data-testid="sign-in-access-denied"]')!;
    expect(warning.textContent).toContain("To use Chrome's sign-ins, turn on Google Chrome under Privacy & Security › Files & Folders › Rig");
    await click(button('Open System Settings'));
    expect(pages.openPrivacySettings).toHaveBeenCalledOnce();
  });

  it('differing statuses: only the refused browser is warned about', async () => {
    state.browsers = [
      { id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' },
      { id: 'arc', name: 'Arc', folder: 'denied', keychain: 'unknown' },
    ];
    await renderSettings();
    const warnings = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="sign-in-access-denied"]'));
    expect(warnings.map((w) => w.dataset.browser)).toEqual(['arc']);
    expect(warnings[0]!.textContent).toContain("To use Arc's sign-ins, turn on Arc under");
  });

  it('says plainly when there is no Chrome', async () => {
    state.browsers = [];
    await renderSettings();
    expect(text()).toContain('Use your Chrome sign-ins');
    expect(document.querySelector('[data-testid="sign-in-no-browser"]')?.textContent).toContain('Sign in here');
    expect(Array.from(document.querySelectorAll('button')).some((b) => /Connect/.test(b.textContent ?? ''))).toBe(false);
  });
});

describe("this page isn't shared with the account (case 8)", () => {
  const onHide = vi.fn();

  async function renderNotShared(url = DOC) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <div style={{ position: 'relative', width: 800, height: 600 }}>
            <AccountChip site={google} pageUrl={url} where={WHERE} onSignInHere={onSignInHere} notShared />
            <button type="button" data-testid="page-content">
              the page
            </button>
            <NotSharedNotice site={google} pageUrl={url} onHide={onHide} />
            <SignInSheet siteId={google.id} onSignInHere={onSignInHere} />
          </div>
        </QueryClientProvider>
      );
    });
    await settle();
  }

  it('names the page and the account, over the page, with Switch account and Open in Chrome', async () => {
    state.sites = [record()];
    await renderNotShared();
    const notice = document.querySelector<HTMLElement>('[data-testid="not-shared"]')!;
    expect(notice.textContent).toContain("This Doc isn't shared with me@example.test");
    expect(notice.textContent).toContain('Comments on it are still in the chat.');
    // A card over the page, not a cover: the page is still there and usable.
    expect(document.querySelector('[data-testid="page-content"]')).not.toBeNull();
    expect(chip().dataset.state).toBe('not-shared');
    expect(chip().textContent).toContain('me@example.test· no access');
    await click(button('Open in Chrome'));
    expect(pages.openInBrowser).toHaveBeenCalledWith({ url: DOC });
    await click(button('Switch account'));
    expect(step()).toBe('share');
    expect(sheet()!.textContent).toContain('Switch the Google account');
  });

  it('falls back to the connected profile, then to "your account"', async () => {
    state.connection = { ...CONNECTED, email: 'you@work.example' };
    await renderNotShared('https://docs.google.com/spreadsheets/d/1/edit');
    expect(document.querySelector('[data-testid="not-shared"]')?.textContent).toContain("This Sheet isn't shared with you@work.example");
    state.connection = null;
    await act(async () => void queryClient.invalidateQueries());
    await settle();
    expect(document.querySelector('[data-testid="not-shared"]')?.textContent).toContain("This Sheet isn't shared with your account");
  });

  it('hides with ✕', async () => {
    await renderNotShared();
    await click(document.querySelector<HTMLElement>('[data-testid="not-shared"] [aria-label="Hide"]')!);
    expect(onHide).toHaveBeenCalledOnce();
  });
});
