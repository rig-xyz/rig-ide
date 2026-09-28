import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_SIGN_INS, type BrowserConnection, type PageSignInsState } from '@shared/pages/sign-in-sites';
import { RigSettingsStore } from '../settings';
import { chromeTime, FIXTURE_PASSWORD, fixtureApps, fixtureRoot, writeBrowser } from './chrome-fixture';
import { SignInReadError, type CookieToSet, type JarCookie, type KeychainRead } from './chrome-sign-in';
import { AUTO_SIGN_IN_EVERY_MS, createPageSignIns, type CheckResult, type PageSignInDeps } from './page-sign-ins';

// Every browser folder here is a synthetic fixture; the Keychain, the
// check window and the pages profile are fakes.

const now = Date.now();
const DOC = 'https://docs.google.com/document/d/abc/edit';
const CONNECTED: BrowserConnection = {
  browser: 'chrome',
  browserName: 'Chrome',
  profile: 'Default',
  profileName: 'Personal',
  email: 'me@example.test',
  connectedAt: 1,
};

function chromeWithTwoProfiles(root: string) {
  return writeBrowser(root, 'Google/Chrome', [
    {
      dir: 'Default',
      name: 'Personal',
      email: 'me@example.test',
      activeAt: now - 86_400_000,
      cookies: [
        { host: '.google.com', name: 'SID', value: 'personal-sid', updated: now - 86_400_000 },
        { host: 'accounts.google.com', name: '__Host-GAPS', value: 'personal-gaps', updated: now - 86_400_000 },
        { host: '.youtube.com', name: 'VISITOR', value: 'never-copied' },
      ],
    },
    { dir: 'Profile 2', name: 'Work', email: 'you@work.example', activeAt: now - 60_000, cookies: [{ host: '.google.com', name: 'SID', value: 'work-sid', lastAccess: now - 3 * 86_400_000 }] },
  ]);
}

/** The pages profile's jar, as Electron lists it. */
function fakeJar(initial: JarCookie[] = []) {
  const jar: JarCookie[] = [...initial];
  return {
    jar,
    pages: {
      set: vi.fn(async (c: CookieToSet) => {
        jar.push({ domain: c.domain ?? new URL(c.url).hostname, hostOnly: !c.domain, name: c.name, value: c.value, path: c.path });
      }),
      list: async () => [...jar],
      remove: vi.fn(async (url: string, name: string) => {
        const host = new URL(url).hostname;
        const i = jar.findIndex((c) => c.name === name && c.domain?.replace(/^\./, '') === host);
        if (i >= 0) jar.splice(i, 1);
      }),
    },
  };
}

function setup(over: Partial<PageSignInDeps> = {}, initial: Partial<PageSignInsState> = {}) {
  const root = fixtureRoot();
  const chromeDir = chromeWithTwoProfiles(root);
  let state: PageSignInsState = { ...DEFAULT_PAGE_SIGN_INS, ...initial };
  const { jar, pages } = fakeJar([{ domain: '.notion.so', name: 'token_v2', value: 'untouched' }]);
  const keychain = vi.fn(async (): Promise<KeychainRead> => ({ password: FIXTURE_PASSWORD, silent: false }));
  const check = vi.fn<PageSignInDeps['check']>(async (_site, cookies) => ({ ok: true, cookies }));
  const flow = createPageSignIns({
    root,
    appDirs: fixtureApps(root),
    now: () => now,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    keychain,
    check,
    pages,
    ...over,
  });
  return { flow, root, chromeDir, jar, pages, keychain, check, state: () => state };
}

const names = (jar: JarCookie[]) => jar.map((c) => `${c.domain}:${c.name}=${c.value}`).sort();

describe('page sign-ins: options', () => {
  it('lists the profiles signed in to the site, hiding the rest, and notes folder access', () => {
    const { flow, state } = setup();
    const options = flow.options('google.com', DOC);
    expect(options.ok && options.profiles.map((p) => [p.name, p.email])).toEqual([
      ['Personal', 'me@example.test'],
      ['Work', 'you@work.example'],
    ]);
    expect(options.ok && options.site.hosts).toEqual(['docs.google.com', 'accounts.google.com', 'google.com']);
    expect(state().access.chrome).toEqual({ folder: 'granted', keychain: 'unknown' });
  });

  it('says when no browser is installed, even with a data folder left behind', () => {
    const root = fixtureRoot();
    writeBrowser(root, 'Google/Chrome', [], { installed: false });
    const flow = createPageSignIns({
      root,
      appDirs: fixtureApps(root),
      getState: () => DEFAULT_PAGE_SIGN_INS,
      setState: () => {},
      keychain: vi.fn(),
      check: vi.fn(),
      pages: fakeJar().pages,
    });
    expect(flow.options('google.com')).toEqual({ ok: false, reason: 'no_browser' });
  });
});

describe('page sign-ins: signIn', () => {
  it("copies only the site's hosts, after the check, and remembers where they came from (never values)", async () => {
    const { flow, jar, check, state, keychain } = setup();
    const result = await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default', pageUrl: DOC });
    expect(result).toMatchObject({ ok: true, record: { site: 'google.com', profileName: 'Personal', account: 'me@example.test', browserName: 'Chrome' } });
    expect(keychain).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]![2]).toBe(DOC);
    expect(names(jar)).toEqual(['.google.com:SID=personal-sid', '.notion.so:token_v2=untouched', 'accounts.google.com:__Host-GAPS=personal-gaps']);
    const saved = state();
    expect(saved.sites['google.com']).toMatchObject({ hosts: ['docs.google.com', 'accounts.google.com', 'google.com'], checkUrl: DOC, importedAt: now });
    expect(saved.access.chrome).toEqual({ folder: 'granted', keychain: 'granted' });
    expect(JSON.stringify(saved)).not.toMatch(/personal-sid|personal-gaps/);
  });

  it('writes the checked copy (a cookie the site rotated while checking comes across rotated)', async () => {
    const rotated = vi.fn<PageSignInDeps['check']>(async (_s, cookies) => ({
      ok: true,
      cookies: cookies.map((c) => (c.name === 'SID' ? { ...c, value: 'rotated' } : c)),
    }));
    const { flow, jar } = setup({ check: rotated });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    expect(names(jar)).toContain('.google.com:SID=rotated');
    expect(rotated.mock.calls[0]![2]).toBe('https://docs.google.com/document/u/0/');
  });

  it('writes nothing when the site refuses the copy (case 7)', async () => {
    const { flow, jar, state } = setup({ check: vi.fn(async (): Promise<CheckResult> => ({ ok: false, reason: 'rejected_by_site' })) });
    expect(await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default', pageUrl: DOC })).toEqual({
      ok: false,
      reason: 'rejected_by_site',
      browser: 'chrome',
    });
    expect(names(jar)).toEqual(['.notion.so:token_v2=untouched']);
    expect(state().sites).toEqual({});
  });

  it('reads a Keychain denial as keychain_denied, and writes nothing (case 4)', async () => {
    const { flow, jar, check } = setup({
      keychain: vi.fn(async () => {
        throw new SignInReadError('keychain_denied', 'chrome');
      }),
    });
    expect(await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' })).toMatchObject({ ok: false, reason: 'keychain_denied' });
    expect(check).not.toHaveBeenCalled();
    expect(jar).toHaveLength(1);
  });

  it('says not_signed_in for a profile without the site, or one that is gone (case 5)', async () => {
    const { flow, keychain } = setup();
    expect(await flow.signIn({ site: 'notion.so', browser: 'chrome', profile: 'Default' })).toMatchObject({ ok: false, reason: 'not_signed_in' });
    expect(await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Profile 7' })).toMatchObject({ ok: false, reason: 'not_signed_in' });
    expect(keychain).not.toHaveBeenCalled();
  });

  it('stops on Cancel mid-check and writes nothing (cases 1 and 12)', async () => {
    let release!: () => void;
    const check = vi.fn<PageSignInDeps['check']>(
      (_s, cookies, _u, signal) =>
        new Promise<CheckResult>((resolve) => {
          release = () => resolve({ ok: true, cookies });
          signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
        })
    );
    const { flow, jar, state } = setup({ check });
    const pending = flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    flow.cancel('google.com');
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(jar).toHaveLength(1);
    expect(state().sites).toEqual({});
  });

  it('switching account replaces the old copy for those hosts only (case 6)', async () => {
    const { flow, jar } = setup();
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    const result = await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Profile 2' });
    expect(result).toMatchObject({ ok: true, record: { profileName: 'Work', account: 'you@work.example' } });
    expect(names(jar)).toEqual(['.google.com:SID=work-sid', '.notion.so:token_v2=untouched']);
  });

  it('notes a Keychain read that answered without asking as silent (Always Allow)', async () => {
    const { flow, state } = setup({ keychain: vi.fn(async () => ({ password: FIXTURE_PASSWORD, silent: true })) });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    expect(state().access.chrome?.keychain).toBe('silent');
  });
});

describe('page sign-ins: sign out, expiry, list', () => {
  it("signing out clears every copied host in rig's pages only, and forgets the site (case 13)", async () => {
    const { flow, jar, state } = setup();
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    await flow.signOut('google.com');
    expect(names(jar)).toEqual(['.notion.so:token_v2=untouched']);
    expect(state().sites).toEqual({});
  });

  it('marks a sign-in expired when its page hits a sign-in wall, and a new sign-in clears it (case 9)', async () => {
    const { flow, state } = setup();
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    flow.markWall('google.com');
    expect(state().sites['google.com']?.expired).toBe(true);
    flow.markWall('notion.so');
    expect(state().sites['notion.so']).toBeUndefined();
    await flow.refresh('google.com');
    expect(state().sites['google.com']?.expired).toBeUndefined();
  });

  it('lists sites and each installed browser with what rig knows of its permissions', async () => {
    const { flow } = setup();
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    flow.setKeepInStep(true);
    const list = flow.list();
    expect(list.sites.map((s) => s.site)).toEqual(['google.com']);
    expect(list.keepInStep).toBe(true);
    expect(list.browsers).toEqual([{ id: 'chrome', name: 'Chrome', folder: 'granted', keychain: 'granted' }]);
  });
});

describe('page sign-ins: keep in step', () => {
  function bumpChrome(chromeDir: string, at: number) {
    const db = new DatabaseSync(path.join(chromeDir, 'Default', 'Network', 'Cookies'));
    db.prepare("UPDATE cookies SET last_update_utc = ? WHERE host_key = '.google.com'").run(chromeTime(at));
    db.close();
  }

  it('does nothing when off, even with a newer sign-in in the browser', async () => {
    const silent = vi.fn(async () => ({ password: FIXTURE_PASSWORD, silent: true }));
    const { flow, chromeDir, state, check } = setup({ keychain: silent });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    check.mockClear();
    bumpChrome(chromeDir, now);
    await flow.keepInStep();
    expect(check).not.toHaveBeenCalled();
    expect(state().sites['google.com']?.refreshAvailable).toBeUndefined();
  });

  it('does nothing when the browser has nothing newer', async () => {
    const { flow, keychain, check, state } = setup({ keychain: vi.fn(async () => ({ password: FIXTURE_PASSWORD, silent: true })) }, { keepInStep: true, connection: CONNECTED });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    keychain.mockClear();
    check.mockClear();
    await flow.keepInStep();
    expect(check).not.toHaveBeenCalled();
    expect(state().sites['google.com']?.refreshAvailable).toBeUndefined();
  });

  it('only marks a refresh available when the Keychain would ask', async () => {
    const { flow, keychain, chromeDir, state } = setup({}, { keepInStep: true, connection: CONNECTED });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    keychain.mockClear();
    bumpChrome(chromeDir, now);
    await flow.keepInStep();
    expect(keychain).not.toHaveBeenCalled();
    expect(state().sites['google.com']?.refreshAvailable).toBe(true);
  });

  it('picks up the newer sign-in silently after Always Allow, checked as ever', async () => {
    const keychain = vi.fn<PageSignInDeps['keychain']>(async () => ({ password: FIXTURE_PASSWORD, silent: true }));
    const { flow, chromeDir, state, check } = setup({ keychain }, { keepInStep: true, connection: CONNECTED });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default', pageUrl: DOC });
    check.mockClear();
    bumpChrome(chromeDir, now);
    await flow.keepInStep();
    expect(keychain.mock.calls[1]![1]).toMatchObject({ timeoutMs: expect.any(Number) });
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]![2]).toBe(DOC);
    expect(Math.abs(state().sites['google.com']!.sourceUpdatedAt - now)).toBeLessThan(2);
    // Once a minute at most, however often the window is focused.
    await flow.keepInStep();
    expect(check).toHaveBeenCalledOnce();
  });

  it('stops trying silently once a read would have asked', async () => {
    const keychain = vi
      .fn<PageSignInDeps['keychain']>()
      .mockResolvedValueOnce({ password: FIXTURE_PASSWORD, silent: true })
      .mockRejectedValueOnce(new SignInReadError('keychain_denied', 'chrome'));
    const { flow, chromeDir, state } = setup({ keychain }, { keepInStep: true, connection: CONNECTED });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    bumpChrome(chromeDir, now);
    await flow.keepInStep();
    expect(state().access.chrome?.keychain).toBe('granted');
    expect(state().sites['google.com']?.refreshAvailable).toBe(true);
  });
});

describe('page sign-ins in the settings file', () => {
  it('persist across launches, without cookie values', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'rig-settings-')), 'settings.json');
    const store = new RigSettingsStore(file);
    store.initialize();
    const { flow } = setup({ getState: () => store.get().pageSignIns, setState: (pageSignIns) => void store.set({ pageSignIns }) });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    flow.setKeepInStep(true);
    const reopened = new RigSettingsStore(file);
    reopened.initialize();
    expect(reopened.get().pageSignIns.sites['google.com']).toMatchObject({ profileName: 'Personal', account: 'me@example.test' });
    expect(reopened.get().pageSignIns.keepInStep).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toMatch(/personal-sid|personal-gaps/);
  });
});

describe('connect Chrome once', () => {
  it('lists every profile of the installed browsers, most recently active first, and notes folder access', () => {
    const { flow, state } = setup();
    const options = flow.connectOptions();
    expect(options.ok && options.profiles.map((p) => [p.name, p.email])).toEqual([
      ['Work', 'you@work.example'],
      ['Personal', 'me@example.test'],
    ]);
    expect(options.ok && options.browsers).toEqual([{ id: 'chrome', name: 'Chrome' }]);
    expect(state().access.chrome?.folder).toBe('granted');
  });

  it('connects a profile with one Keychain read and no cookie read', async () => {
    const { flow, state, keychain, check, pages } = setup();
    const result = await flow.connect({ browser: 'chrome', profile: 'Default' });
    expect(result).toMatchObject({ ok: true, connection: { browser: 'chrome', profile: 'Default', profileName: 'Personal', email: 'me@example.test', connectedAt: now } });
    expect(keychain).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
    expect(pages.set).not.toHaveBeenCalled();
    expect(state().connection?.profileName).toBe('Personal');
    expect(state().access.chrome).toEqual({ folder: 'granted', keychain: 'granted' });
    expect(flow.list().connection?.email).toBe('me@example.test');
  });

  it('stays disconnected when the Keychain is denied', async () => {
    const { flow, state } = setup({
      keychain: vi.fn(async () => {
        throw new SignInReadError('keychain_denied', 'chrome');
      }),
    });
    expect(await flow.connect({ browser: 'chrome', profile: 'Default' })).toMatchObject({ ok: false, reason: 'keychain_denied' });
    expect(state().connection).toBeNull();
  });

  it('disconnecting keeps signed-in sites unless asked to sign out of all', async () => {
    const { flow, state, jar } = setup({}, { connection: CONNECTED });
    await flow.autoSignIn({ pageUrl: DOC });
    await flow.disconnect();
    expect(state().connection).toBeNull();
    expect(Object.keys(state().sites)).toEqual(['google.com']);
    await flow.disconnect({ signOutAll: true });
    expect(state().sites).toEqual({});
    expect(names(jar)).toEqual(['.notion.so:token_v2=untouched']);
  });
});

describe('automatic sign-in for a page the person opened', () => {
  it('does nothing until Chrome is connected', async () => {
    const { flow, keychain } = setup();
    expect(await flow.autoSignIn({ pageUrl: DOC })).toEqual({ ok: false, reason: 'not_connected' });
    expect(keychain).not.toHaveBeenCalled();
  });

  it("copies that site's hosts from the connected profile, checked on the page, and records it", async () => {
    const { flow, jar, check, state } = setup({}, { connection: CONNECTED });
    const result = await flow.autoSignIn({ pageUrl: DOC });
    expect(result).toMatchObject({ ok: true, record: { site: 'google.com', account: 'me@example.test', profileName: 'Personal' } });
    expect(check.mock.calls[0]![2]).toBe(DOC);
    expect(names(jar)).toEqual(['.google.com:SID=personal-sid', '.notion.so:token_v2=untouched', 'accounts.google.com:__Host-GAPS=personal-gaps']);
    expect(state().sites['google.com']?.checkUrl).toBe(DOC);
  });

  it('leaves a site already signed in alone', async () => {
    const { flow, keychain } = setup({}, { connection: CONNECTED });
    await flow.autoSignIn({ pageUrl: DOC });
    keychain.mockClear();
    expect(await flow.autoSignIn({ pageUrl: DOC })).toMatchObject({ ok: true });
    expect(keychain).not.toHaveBeenCalled();
  });

  it("says when the connected profile has no sign-in for the site, without asking the Keychain", async () => {
    const { flow, keychain } = setup({}, { connection: CONNECTED });
    expect(await flow.autoSignIn({ pageUrl: 'https://www.notion.so/Roadmap' })).toEqual({ ok: false, reason: 'not_signed_in_in_browser', browser: 'chrome' });
    expect(keychain).not.toHaveBeenCalled();
  });

  it('lets the Keychain ask at most once per site per run of the app', async () => {
    const keychain = vi.fn<PageSignInDeps['keychain']>(async () => {
      throw new SignInReadError('keychain_denied', 'chrome');
    });
    const { flow } = setup({ keychain }, { connection: CONNECTED });
    expect(await flow.autoSignIn({ pageUrl: DOC })).toMatchObject({ ok: false, reason: 'keychain_denied' });
    expect(await flow.autoSignIn({ pageUrl: DOC, retry: true })).toEqual({ ok: false, reason: 'keychain_would_prompt', browser: 'chrome' });
    expect(keychain).toHaveBeenCalledOnce();
    expect(keychain.mock.calls[0]![1]).not.toHaveProperty('timeoutMs');
  });

  it('reads silently (bounded) once the Keychain answers without asking', async () => {
    const keychain = vi.fn<PageSignInDeps['keychain']>(async () => ({ password: FIXTURE_PASSWORD, silent: true }));
    const { flow } = setup({ keychain }, { connection: CONNECTED, access: { chrome: { folder: 'granted', keychain: 'silent' } } });
    expect(await flow.autoSignIn({ pageUrl: DOC })).toMatchObject({ ok: true });
    expect(keychain.mock.calls[0]![1]).toMatchObject({ timeoutMs: expect.any(Number) });
  });

  it('is rate-limited per site, and re-imports an expired sign-in after that', async () => {
    let clock = now;
    const keychain = vi.fn<PageSignInDeps['keychain']>(async () => ({ password: FIXTURE_PASSWORD, silent: true }));
    const { flow, state, check } = setup({ keychain, now: () => clock }, { connection: CONNECTED });
    await flow.autoSignIn({ pageUrl: DOC });
    flow.markWall('google.com');
    expect(await flow.autoSignIn({ pageUrl: DOC })).toEqual({ ok: false, reason: 'rate_limited' });
    expect(check).toHaveBeenCalledOnce();
    clock += AUTO_SIGN_IN_EVERY_MS;
    expect(await flow.autoSignIn({ pageUrl: DOC })).toMatchObject({ ok: true });
    expect(check).toHaveBeenCalledTimes(2);
    expect(state().sites['google.com']?.expired).toBeUndefined();
  });

  it('lets the person retry inside the window (not a loop: only on their action)', async () => {
    const { flow } = setup({}, { connection: CONNECTED });
    expect(await flow.autoSignIn({ pageUrl: 'https://www.notion.so/x' })).toMatchObject({ reason: 'not_signed_in_in_browser' });
    expect(await flow.autoSignIn({ pageUrl: 'https://www.notion.so/x' })).toMatchObject({ reason: 'rate_limited' });
    expect(await flow.autoSignIn({ pageUrl: 'https://www.notion.so/x', retry: true })).toMatchObject({ reason: 'not_signed_in_in_browser' });
  });

  it('keep in step does nothing while disconnected', async () => {
    const { flow, chromeDir, check } = setup({ keychain: vi.fn(async () => ({ password: FIXTURE_PASSWORD, silent: true })) }, { keepInStep: true });
    await flow.signIn({ site: 'google.com', browser: 'chrome', profile: 'Default' });
    check.mockClear();
    const db = new DatabaseSync(path.join(chromeDir, 'Default', 'Network', 'Cookies'));
    db.prepare("UPDATE cookies SET last_update_utc = ? WHERE host_key = '.google.com'").run(chromeTime(now));
    db.close();
    await flow.keepInStep();
    expect(check).not.toHaveBeenCalled();
  });
});
