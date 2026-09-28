import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSignInRecord } from '@shared/pages/sign-in-sites';

/**
 * Signing pages in (canvas board 18), renderer side: the page header's
 * account chip and its menus, the sign-in-wall banner, the sheet's steps
 * and exits, abandoning it midway, and the error states' actions.
 * Settings › Sign-ins too. Main is a mock: no browser data anywhere.
 */

type Access = { id: 'chrome' | 'arc'; name: string; folder: 'granted' | 'denied' | 'unknown'; keychain: 'unknown' | 'granted' | 'silent' };

const state = vi.hoisted(() => ({
  sites: [] as PageSignInRecord[],
  keepInStep: false,
  browsers: [] as Access[],
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
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { rig: { pages } },
  events: { on: vi.fn(() => () => {}) },
}));

import { AccountChip, SignInBanner } from '@renderer/features/pages/account-chip';
import { SignInRows } from '@renderer/features/pages/sign-in';
import { resetSignInFlows, signInFlow, WATCH_RETRY_MS } from '@renderer/features/pages/sign-in-flow';
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
  state.sites = [];
  state.keepInStep = false;
  state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'unknown', keychain: 'unknown' }];
  for (const fn of Object.values(pages)) fn.mockClear();
  pages.signIns.mockImplementation(async () => ({ sites: state.sites, keepInStep: state.keepInStep, browsers: state.browsers }));
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
          <AccountChip site={site} pageUrl={url} onSignInHere={onSignInHere} />
          <SignInBanner site={site} pageUrl={url} wall={opts.wall ?? false} dismissed={opts.dismissed ?? false} onDismiss={onDismiss} />
          <button type="button" data-testid="page-content">
            the page
          </button>
          <SignInSheet siteId={site.id} onSignInHere={onSignInHere} />
        </div>
      </QueryClientProvider>
    );
  });
  await settle();
}

const chip = () => document.querySelector<HTMLElement>('[data-testid="account-chip"]')!;
const sheet = () => document.querySelector<HTMLElement>('[data-testid="sign-in-sheet"]');
const step = () => sheet()?.dataset.step ?? null;

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
  it('signed out: offers the browser sign-in, signing in here, and the page in the browser', async () => {
    await renderPage(notion, NOTION);
    expect(chip().dataset.state).toBe('signed-out');
    expect(chip().textContent).toBe('Not signed in');
    await click(chip());
    expect(menuTexts()).toEqual(['Use Chrome sign-in for Notion', 'Sign in here', 'Open in Chrome']);
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
    expect(menuTexts()[0]).toBe('Use Arc sign-in for Google');
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
  it('shows on a sign-in wall, opens the sheet, and hides with ✕', async () => {
    await renderPage(google, DOC, { wall: true });
    const banner = document.querySelector('[data-testid="sign-in-banner"]')!;
    expect(banner.textContent).toContain('This page wants you signed in. Use your Chrome sign-in for Google?');
    await click(banner.querySelector<HTMLElement>('[aria-label="Hide for this page"]')!);
    expect(onDismiss).toHaveBeenCalled();
    await click(button('Use Chrome sign-in'));
    expect(step()).toBe('share');
    expect(document.querySelector('[data-testid="sign-in-banner"]')).toBeNull();
  });

  it('stays away when dismissed, or when there is no wall', async () => {
    await renderPage(google, DOC, { wall: true, dismissed: true });
    expect(document.querySelector('[data-testid="sign-in-banner"]')).toBeNull();
    await renderPage(google, DOC, { wall: false });
    expect(document.querySelector('[data-testid="sign-in-banner"]')).toBeNull();
  });
});

describe('the sheet', () => {
  it('first time: hosts → macOS heads-up → profiles listed → pick → checking → done', async () => {
    await renderPage();
    await click(chip());
    await click(button('Use Chrome sign-in for Google'));
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

  it('lists any signed-in site with where it came from and its hosts; Remove signs out in rig', async () => {
    state.sites = [record(), record({ site: 'claude.ai', siteName: 'Claude', hosts: ['claude.ai'], expired: true, checkUrl: 'https://claude.ai/recents' })];
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
    await renderSettings();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="sign-in-site"]'));
    expect(rows.map((r) => r.dataset.site)).toEqual(['google.com', 'claude.ai']);
    expect(rows[0]!.textContent).toContain('Chrome · Personal · docs.google.com, accounts.google.com, google.com');
    expect(rows[1]!.textContent).toContain('expired');
    expect(rows[1]!.textContent).toContain('Refresh from Chrome');
    expect(document.querySelector('[data-testid="sign-in-access"]')?.textContent).toContain('Allowed');
    await click(Array.from(rows[0]!.querySelectorAll('button')).find((b) => b.textContent === 'Remove')!);
    expect(pages.signOut).toHaveBeenCalledWith({ site: 'google.com' });
    expect(document.querySelector('[data-testid="keep-in-step"]')).not.toBeNull();
  });

  it('with the permission off: says so and opens System Settings', async () => {
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'denied', keychain: 'unknown' }];
    await renderSettings();
    const access = document.querySelector<HTMLElement>('[data-testid="sign-in-access"]')!;
    expect(access.textContent).toContain('Not allowed');
    expect(access.textContent).toContain('Signed-in sites keep working');
    await click(button('Open System Settings'));
    expect(pages.openPrivacySettings).toHaveBeenCalledOnce();
  });

  it('Add a site runs the same sheet inline for any site', async () => {
    await renderSettings();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add a site"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'dash.acme.dev');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Add a site'));
    expect(step()).toBe('share');
    expect(document.querySelector('[data-testid="sign-in-hosts"]')?.textContent).toBe('acme.devwww.acme.devdash.acme.dev');
  });

  it('Switch opens the picker for that site', async () => {
    state.sites = [record()];
    state.browsers = [{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'silent' }];
    pages.signInOptions.mockResolvedValue(options([personal]));
    await renderSettings();
    await click(button('Switch'));
    expect(step()).toBe('share');
    expect(sheet()!.textContent).toContain('Switch the Google account');
    expect(document.querySelectorAll('[data-testid="sign-in-profile"]')).toHaveLength(1);
  });

  it('says plainly when there is no Chrome', async () => {
    state.browsers = [];
    await renderSettings();
    expect(document.querySelector('[data-testid="sign-in-no-browser"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="Add a site"]')).toBeNull();
  });
});
