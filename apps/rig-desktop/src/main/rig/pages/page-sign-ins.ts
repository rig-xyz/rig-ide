import {
  cookieHostMatches,
  signInSiteFor,
  signInSiteForUrl,
  type BrowserAccess,
  type BrowserId,
  type PageSignInRecord,
  type PageSignInsState,
  type ProfileWithSignIn,
  type SignInFailureReason,
  type SignInSite,
} from '@shared/pages/sign-in-sites';
import {
  APP_SUPPORT,
  CHROMIUM_BROWSERS,
  installedBrowsers,
  listProfiles,
  profilesWithSignIn,
  readSiteCookies,
  siteActivity,
  SignInReadError,
  type BrowserSpec,
  type CookieToSet,
  type JarCookie,
  type KeychainRead,
} from './chrome-sign-in';

/**
 * Signing pages in, for any site (canvas board 18): the flow behind the
 * page header's chip, the sheet and Settings › Sign-ins, with Electron and
 * the settings file passed in so it runs against fixtures in tests.
 *
 * - `options` lists the profiles signed in to a site (no cookie values).
 * - `signIn` reads one profile's cookies for the site's hosts, checks them in
 *   a throwaway profile, and only then writes them to the pages profile and
 *   remembers where they came from (never the values).
 * - `signOut` clears exactly the site's hosts in the pages profile.
 * - `keepInStep` (on app focus) picks up newer sign-ins for approved sites,
 *   only when the Keychain answers without asking; otherwise it marks a
 *   refresh available.
 */

export type CheckResult = { ok: true; cookies: CookieToSet[] } | { ok: false; reason: 'rejected_by_site' | 'cancelled' | 'failed' };

export interface PageSignInDeps {
  /** Where browsers keep their data (fixtures in tests). */
  root?: string;
  now?: () => number;
  getState(): PageSignInsState;
  setState(next: PageSignInsState): void;
  keychain(browser: BrowserSpec, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<KeychainRead>;
  check(site: SignInSite, cookies: CookieToSet[], url: string, signal?: AbortSignal): Promise<CheckResult>;
  /** The pages browser profile's cookie jar. */
  pages: {
    set(cookie: CookieToSet): Promise<void>;
    list(): Promise<JarCookie[]>;
    remove(url: string, name: string): Promise<void>;
  };
  onChange?(): void;
}

export type SignInOptions =
  | {
      ok: true;
      site: SignInSite;
      browsers: { id: BrowserId; name: string }[];
      /** Signed in to the site, most recently used first. */
      profiles: ProfileWithSignIn[];
      /** Browsers macOS didn't let rig read. */
      denied: BrowserId[];
    }
  | { ok: false; reason: 'no_browser' | 'folder_access_denied' | 'failed'; browser?: BrowserId };

export type SignInOutcome = { ok: true; record: PageSignInRecord } | { ok: false; reason: SignInFailureReason; browser?: BrowserId };

export interface SignInsList {
  sites: PageSignInRecord[];
  keepInStep: boolean;
  /** Installed browsers, with what rig knows of macOS's permissions for each. */
  browsers: ({ id: BrowserId; name: string } & BrowserAccess)[];
}

/** A silent Keychain read (Keep in step) that takes longer than this was about to ask: it's stopped. */
const SILENT_KEYCHAIN_TIMEOUT_MS = 3_000;
/** Keep in step looks at most this often, however often the window is focused. */
const KEEP_IN_STEP_EVERY_MS = 60_000;

const UNKNOWN_ACCESS: BrowserAccess = { folder: 'unknown', keychain: 'unknown' };

function failure(error: unknown): { reason: SignInFailureReason; browser?: BrowserId } {
  if (error instanceof SignInReadError) return { reason: error.reason, ...(error.browser ? { browser: error.browser } : {}) };
  return { reason: 'failed' };
}

export function createPageSignIns(deps: PageSignInDeps) {
  const root = deps.root ?? APP_SUPPORT;
  const now = deps.now ?? Date.now;
  const inflight = new Map<string, AbortController>();
  let lastKeepInStep = 0;

  function update(change: (state: PageSignInsState) => PageSignInsState): void {
    deps.setState(change(deps.getState()));
    deps.onChange?.();
  }

  function noteAccess(browser: BrowserId | undefined, patch: Partial<BrowserAccess>): void {
    if (!browser) return;
    const current = deps.getState().access[browser] ?? UNKNOWN_ACCESS;
    if (Object.entries(patch).every(([k, v]) => current[k as keyof BrowserAccess] === v)) return;
    update((s) => ({ ...s, access: { ...s.access, [browser]: { ...current, ...patch } } }));
  }

  function patchRecord(siteId: string, patch: Partial<PageSignInRecord>): void {
    const record = deps.getState().sites[siteId];
    if (!record) return;
    update((s) => ({ ...s, sites: { ...s.sites, [siteId]: { ...record, ...patch } } }));
  }

  /** The site for an id, with the page's host when it came from a page. */
  function siteFor(siteId: string, pageUrl?: string): SignInSite {
    const fromPage = pageUrl ? signInSiteForUrl(pageUrl) : null;
    if (fromPage && fromPage.id === siteId) return fromPage;
    const record = deps.getState().sites[siteId];
    return record ? { ...signInSiteFor(siteId), hosts: record.hosts, checkUrl: record.checkUrl } : signInSiteFor(siteId);
  }

  /** Clears a site's hosts from the pages profile (nothing else). */
  async function clearHosts(hosts: readonly string[]): Promise<void> {
    for (const cookie of await deps.pages.list()) {
      if (!cookie.domain || !cookieHostMatches(cookie.domain, hosts)) continue;
      const host = cookie.domain.replace(/^\./, '');
      await deps.pages.remove(`https://${host}${cookie.path ?? '/'}`, cookie.name).catch(() => {});
    }
  }

  function options(siteId: string, pageUrl?: string): SignInOptions {
    const site = siteFor(siteId, pageUrl);
    try {
      const found = profilesWithSignIn(site.hosts, root, now());
      for (const b of found.browsers) noteAccess(b.id, { folder: found.denied.includes(b.id) ? 'denied' : 'granted' });
      return {
        ok: true,
        site,
        browsers: found.browsers,
        profiles: found.profiles.map(({ updatedAt: _updatedAt, ...p }) => p),
        denied: found.denied,
      };
    } catch (error) {
      const f = failure(error);
      if (f.reason === 'folder_access_denied') noteAccess(f.browser, { folder: 'denied' });
      const reason = f.reason === 'no_browser' || f.reason === 'folder_access_denied' ? f.reason : 'failed';
      return { ok: false, reason, ...(f.browser ? { browser: f.browser } : {}) };
    }
  }

  async function runImport(input: {
    site: SignInSite;
    browser: BrowserSpec;
    profileDir: string;
    checkUrl: string;
    signal: AbortSignal;
    silent: boolean;
  }): Promise<SignInOutcome> {
    const { site, browser, profileDir, signal } = input;
    try {
      const profile = listProfiles(browser, root).find((p) => p.dir === profileDir);
      noteAccess(browser.id, { folder: 'granted' });
      if (!profile) return { ok: false, reason: 'not_signed_in', browser: browser.id };
      const activity = siteActivity(browser, profileDir, site.hosts, root, now());
      if (!activity) return { ok: false, reason: 'not_signed_in', browser: browser.id };
      const key = await deps.keychain(browser, { signal, ...(input.silent ? { timeoutMs: SILENT_KEYCHAIN_TIMEOUT_MS } : {}) });
      noteAccess(browser.id, { keychain: key.silent ? 'silent' : 'granted' });
      const cookies = readSiteCookies(browser, profileDir, site.hosts, key.password, root, now());
      const checked = await deps.check(site, cookies, input.checkUrl, signal);
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      if (!checked.ok) return { ok: false, reason: checked.reason, browser: browser.id };
      // Only now, after the check: the old copy (another account) goes, the checked one comes in.
      await clearHosts(site.hosts);
      for (const cookie of checked.cookies) {
        // One cookie Electron refuses (an odd prefix or domain) doesn't stop the rest.
        await deps.pages.set(cookie).catch(() => {});
      }
      const record: PageSignInRecord = {
        site: site.id,
        siteName: site.name,
        browser: browser.id,
        browserName: browser.name,
        profile: profile.dir,
        profileName: profile.name,
        account: profile.email ?? null,
        hosts: site.hosts,
        checkUrl: input.checkUrl,
        importedAt: now(),
        sourceUpdatedAt: activity.updatedAt,
      };
      update((s) => ({ ...s, sites: { ...s.sites, [site.id]: record } }));
      return { ok: true, record };
    } catch (error) {
      const f = failure(error);
      if (f.reason === 'folder_access_denied') noteAccess(browser.id, { folder: 'denied' });
      return { ok: false, reason: signal.aborted ? 'cancelled' : f.reason, ...(f.browser ? { browser: f.browser } : {}) };
    }
  }

  async function withFlight<T>(siteId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    inflight.get(siteId)?.abort();
    const controller = new AbortController();
    inflight.set(siteId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (inflight.get(siteId) === controller) inflight.delete(siteId);
    }
  }

  function specFor(id: string): BrowserSpec | null {
    return CHROMIUM_BROWSERS.find((b) => b.id === id) ?? null;
  }

  /** The person's pick in the sheet: this site, from this browser profile, checked on this page. */
  function signIn(input: { site: string; browser: BrowserId; profile: string; pageUrl?: string }): Promise<SignInOutcome> {
    const browser = specFor(input.browser);
    if (!browser) return Promise.resolve({ ok: false, reason: 'failed' });
    const site = siteFor(input.site, input.pageUrl);
    const checkUrl = input.pageUrl && signInSiteForUrl(input.pageUrl)?.id === site.id ? input.pageUrl : site.checkUrl;
    return withFlight(site.id, (signal) => runImport({ site, browser, profileDir: input.profile, checkUrl, signal, silent: false }));
  }

  /** "Refresh from Chrome": the same browser profile again (macOS may ask). */
  function refresh(siteId: string): Promise<SignInOutcome> {
    const record = deps.getState().sites[siteId];
    const browser = record && specFor(record.browser);
    if (!record || !browser) return Promise.resolve({ ok: false, reason: 'failed' });
    return withFlight(siteId, (signal) =>
      runImport({ site: siteFor(siteId), browser, profileDir: record.profile, checkUrl: record.checkUrl, signal, silent: false })
    );
  }

  /** The sheet's Cancel: stops a read or a check; nothing is written. */
  function cancel(siteId: string): void {
    inflight.get(siteId)?.abort();
  }

  /** "Sign out of <site> in rig" / Settings › Remove: only rig's copy, every host that was copied. */
  async function signOut(siteId: string): Promise<void> {
    cancel(siteId);
    await clearHosts(siteFor(siteId).hosts);
    if (deps.getState().sites[siteId]) {
      update((s) => {
        const { [siteId]: _removed, ...sites } = s.sites;
        return { ...s, sites };
      });
    }
  }

  function list(): SignInsList {
    const state = deps.getState();
    return {
      sites: Object.values(state.sites).sort((a, b) => a.siteName.localeCompare(b.siteName)),
      keepInStep: state.keepInStep,
      browsers: installedBrowsers(root).map((b) => ({ id: b.id, name: b.name, ...(state.access[b.id] ?? UNKNOWN_ACCESS) })),
    };
  }

  function setKeepInStep(on: boolean): void {
    if (deps.getState().keepInStep !== on) update((s) => ({ ...s, keepInStep: on }));
  }

  /** A page of a signed-in site landed on a sign-in wall: the copy has expired or was refused (case 9). */
  function markWall(siteId: string): void {
    const record = deps.getState().sites[siteId];
    if (record && !record.expired) patchRecord(siteId, { expired: true });
  }

  /**
   * "Keep in step with Chrome", on app focus: for sites already approved,
   * when the browser holds a newer sign-in, copy it (checked as ever) if the
   * Keychain answers without asking; otherwise just say a refresh is there.
   */
  async function keepInStep(): Promise<void> {
    const state = deps.getState();
    if (!state.keepInStep || now() - lastKeepInStep < KEEP_IN_STEP_EVERY_MS) return;
    lastKeepInStep = now();
    for (const record of Object.values(state.sites)) {
      const browser = specFor(record.browser);
      const access = deps.getState().access[record.browser] ?? UNKNOWN_ACCESS;
      if (!browser || access.folder !== 'granted' || inflight.has(record.site)) continue;
      let updatedAt: number;
      try {
        const activity = siteActivity(browser, record.profile, record.hosts, root, now());
        if (!activity || activity.updatedAt <= record.sourceUpdatedAt) continue;
        updatedAt = activity.updatedAt;
      } catch (error) {
        if (failure(error).reason === 'folder_access_denied') noteAccess(browser.id, { folder: 'denied' });
        continue;
      }
      if (access.keychain !== 'silent') {
        if (!record.refreshAvailable) patchRecord(record.site, { refreshAvailable: true });
        continue;
      }
      const result = await withFlight(record.site, (signal) =>
        runImport({ site: siteFor(record.site), browser, profileDir: record.profile, checkUrl: record.checkUrl, signal, silent: true })
      );
      if (result.ok) continue;
      // It would have asked: stop trying silently until a read comes back quick again.
      if (result.reason === 'keychain_denied') noteAccess(browser.id, { keychain: 'granted' });
      patchRecord(record.site, { refreshAvailable: result.reason !== 'rejected_by_site', sourceUpdatedAt: result.reason === 'rejected_by_site' ? updatedAt : record.sourceUpdatedAt });
    }
  }

  function recordFor(siteId: string): PageSignInRecord | null {
    return deps.getState().sites[siteId] ?? null;
  }

  return { options, signIn, refresh, cancel, signOut, list, setKeepInStep, markWall, keepInStep, siteFor, recordFor };
}

export type PageSignIns = ReturnType<typeof createPageSignIns>;
