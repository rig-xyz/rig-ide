import {
  cookieHostMatches,
  signInSiteFor,
  signInSiteForUrl,
  type AutoSignInReason,
  type BrowserAccess,
  type BrowserConnection,
  type BrowserId,
  type BrowserProfileInfo,
  type PageSignInRecord,
  type PageSignInsState,
  type ProfileWithSignIn,
  type SignInFailureReason,
  type SignInSite,
} from '@shared/pages/sign-in-sites';
import {
  APP_DIRS,
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
  /** Where browser apps are installed (fixtures in tests). */
  appDirs?: readonly string[];
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
  /** The connected browser profile, or null. */
  connection: BrowserConnection | null;
}

/** "Connect Chrome": the installed browsers' profiles, most recently active first (reading them is what makes macOS ask about folder access). */
export type ConnectOptions =
  | { ok: true; browsers: { id: BrowserId; name: string }[]; profiles: BrowserProfileInfo[]; denied: BrowserId[] }
  | { ok: false; reason: 'no_browser' | 'folder_access_denied' | 'failed'; browser?: BrowserId };

export type ConnectOutcome = { ok: true; connection: BrowserConnection } | { ok: false; reason: SignInFailureReason; browser?: BrowserId };

/** A page the person opened, signed in automatically from the connected profile, or why not. */
export type AutoSignInOutcome = { ok: true; record: PageSignInRecord } | { ok: false; reason: AutoSignInReason; browser?: BrowserId };

/** A silent Keychain read (Keep in step) that takes longer than this was about to ask: it's stopped. */
const SILENT_KEYCHAIN_TIMEOUT_MS = 3_000;
/** Keep in step looks at most this often, however often the window is focused. */
const KEEP_IN_STEP_EVERY_MS = 60_000;
/** A page's automatic sign-in is tried at most this often per site: never a loop. */
export const AUTO_SIGN_IN_EVERY_MS = 5 * 60_000;

const UNKNOWN_ACCESS: BrowserAccess = { folder: 'unknown', keychain: 'unknown' };

/** The in-flight key for "Connect Chrome" (sites are keyed by domain, so this can't collide). */
const CONNECT_FLIGHT = '<connect>';

/** An automatic sign-in's result: "no sign-in in that profile" reads as the browser's, not the page's. */
function autoOutcome(result: SignInOutcome): AutoSignInOutcome {
  return !result.ok && result.reason === 'not_signed_in' ? { ...result, reason: 'not_signed_in_in_browser' } : result;
}

function failure(error: unknown): { reason: SignInFailureReason; browser?: BrowserId } {
  if (error instanceof SignInReadError) return { reason: error.reason, ...(error.browser ? { browser: error.browser } : {}) };
  return { reason: 'failed' };
}

export function createPageSignIns(deps: PageSignInDeps) {
  const root = deps.root ?? APP_SUPPORT;
  const appDirs = deps.appDirs ?? APP_DIRS;
  const now = deps.now ?? Date.now;
  const inflight = new Map<string, AbortController>();
  let lastKeepInStep = 0;
  /** Per site: when a page last tried an automatic sign-in, and whether the Keychain was asked this run of the app. */
  const lastAuto = new Map<string, number>();
  const askedKeychain = new Set<string>();

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
      const found = profilesWithSignIn(site.hosts, root, now(), appDirs);
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
      browsers: installedBrowsers(appDirs).map((b) => ({ id: b.id, name: b.name, ...(state.access[b.id] ?? UNKNOWN_ACCESS) })),
      connection: state.connection,
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
    if (!state.connection || !state.keepInStep || now() - lastKeepInStep < KEEP_IN_STEP_EVERY_MS) return;
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

  /**
   * "Connect Chrome", first step: every installed browser's profiles, most
   * recently active first. Reading the browser's profile list is what makes
   * macOS ask about "data from other apps", so it runs after the heads-up.
   */
  function connectOptions(): ConnectOptions {
    const browsers = installedBrowsers(appDirs);
    if (browsers.length === 0) return { ok: false, reason: 'no_browser' };
    const profiles: BrowserProfileInfo[] = [];
    const denied: BrowserId[] = [];
    for (const b of browsers) {
      try {
        profiles.push(...listProfiles(b, root));
        noteAccess(b.id, { folder: 'granted' });
      } catch (error) {
        if (failure(error).reason !== 'folder_access_denied') continue;
        denied.push(b.id);
        noteAccess(b.id, { folder: 'denied' });
      }
    }
    if (denied.length === browsers.length) return { ok: false, reason: 'folder_access_denied', browser: denied[0] };
    profiles.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    return { ok: true, browsers: browsers.map((b) => ({ id: b.id, name: b.name })), profiles, denied };
  }

  /** "Connect Chrome": the chosen profile, and the Keychain read once (macOS asks; Always Allow makes later reads silent). No cookie is read. */
  function connect(input: { browser: BrowserId; profile: string }): Promise<ConnectOutcome> {
    const spec = specFor(input.browser);
    if (!spec) return Promise.resolve({ ok: false, reason: 'failed' });
    return withFlight(CONNECT_FLIGHT, async (signal): Promise<ConnectOutcome> => {
      try {
        const profile = listProfiles(spec, root).find((p) => p.dir === input.profile);
        noteAccess(spec.id, { folder: 'granted' });
        if (!profile) return { ok: false, reason: 'failed', browser: spec.id };
        const key = await deps.keychain(spec, { signal });
        noteAccess(spec.id, { keychain: key.silent ? 'silent' : 'granted' });
        const connection: BrowserConnection = {
          browser: spec.id,
          browserName: spec.name,
          profile: profile.dir,
          profileName: profile.name,
          email: profile.email,
          connectedAt: now(),
        };
        update((s) => ({ ...s, connection }));
        return { ok: true, connection };
      } catch (error) {
        const f = failure(error);
        if (f.reason === 'folder_access_denied') noteAccess(spec.id, { folder: 'denied' });
        return { ok: false, reason: signal.aborted ? 'cancelled' : f.reason, browser: spec.id };
      }
    });
  }

  function cancelConnect(): void {
    inflight.get(CONNECT_FLIGHT)?.abort();
  }

  /** Disconnect: no more automatic sign-ins. Sites already signed in stay, unless `signOutAll`. */
  async function disconnect(opts: { signOutAll?: boolean } = {}): Promise<void> {
    for (const controller of inflight.values()) controller.abort();
    if (deps.getState().connection) update((s) => ({ ...s, connection: null }));
    if (opts.signOutAll) for (const siteId of Object.keys(deps.getState().sites)) await signOut(siteId);
  }

  /**
   * A page the person opened in the panel, signed in automatically from the
   * connected profile: only that site's hosts, checked as ever. Never for an
   * agent (the controller only calls this for a panel page). At most once per
   * site every few minutes (`retry` is the person asking again), and the
   * Keychain may ask at most once per site per run of the app.
   */
  async function autoSignIn(input: { pageUrl: string; retry?: boolean }): Promise<AutoSignInOutcome> {
    const site = signInSiteForUrl(input.pageUrl);
    if (!site) return { ok: false, reason: 'failed' };
    const state = deps.getState();
    const connection = state.connection;
    if (!connection) return { ok: false, reason: 'not_connected' };
    const existing = state.sites[site.id];
    if (existing && !existing.expired) return { ok: true, record: existing };
    const spec = specFor(connection.browser);
    if (!spec) return { ok: false, reason: 'failed' };
    const last = lastAuto.get(site.id);
    if (inflight.has(site.id) || (!input.retry && last !== undefined && now() - last < AUTO_SIGN_IN_EVERY_MS)) return { ok: false, reason: 'rate_limited' };
    lastAuto.set(site.id, now());
    try {
      // Timestamps only: is there anything to copy at all?
      if (!siteActivity(spec, connection.profile, site.hosts, root, now())) return { ok: false, reason: 'not_signed_in_in_browser', browser: spec.id };
    } catch (error) {
      const f = failure(error);
      if (f.reason === 'folder_access_denied') noteAccess(spec.id, { folder: 'denied' });
      return { ok: false, ...f };
    }
    const run = (silent: boolean) =>
      withFlight(site.id, (signal) => runImport({ site, browser: spec, profileDir: connection.profile, checkUrl: input.pageUrl, signal, silent }));
    let result: SignInOutcome;
    if ((state.access[spec.id] ?? UNKNOWN_ACCESS).keychain === 'silent') {
      result = await run(true);
      // A "silent" read that would have asked: this page's one ask, if it hasn't had it.
      if (result.ok || result.reason !== 'keychain_denied') return autoOutcome(result);
      noteAccess(spec.id, { keychain: 'granted' });
    }
    if (askedKeychain.has(site.id)) return { ok: false, reason: 'keychain_would_prompt', browser: spec.id };
    askedKeychain.add(site.id);
    result = await run(false);
    return autoOutcome(result);
  }

  return {
    options,
    signIn,
    refresh,
    cancel,
    signOut,
    list,
    setKeepInStep,
    markWall,
    keepInStep,
    siteFor,
    recordFor,
    connectOptions,
    connect,
    cancelConnect,
    disconnect,
    autoSignIn,
  };
}

export type PageSignIns = ReturnType<typeof createPageSignIns>;
