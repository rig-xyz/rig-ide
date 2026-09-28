import { createCipheriv, createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_PASSWORD, fixtureRoot, writeBrowser } from './chrome-fixture';
import {
  browserSpec,
  chromeCookieKey,
  decryptChromeCookie,
  installedBrowsers,
  jarCookieToSet,
  listProfiles,
  profilesWithSignIn,
  readSiteCookies,
  siteActivity,
  SignInReadError,
  type ChromeCookieRow,
} from './chrome-sign-in';

// A synthetic cookie encrypted the way Chrome does on macOS; no real
// Keychain or browser data is involved.
function encrypt(value: string, password: string, host: string, dbVersion: number): Uint8Array {
  const plain = dbVersion >= 24 ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  const cipher = createCipheriv('aes-128-cbc', chromeCookieKey(password), Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

const row = (over: Partial<ChromeCookieRow> = {}): ChromeCookieRow => ({
  host_key: '.claude.ai',
  name: 'sessionKey',
  encrypted_value: encrypt('synthetic-value', 'test-password', '.claude.ai', 24),
  path: '/',
  expires_s: 13500000000,
  is_secure: 1,
  is_httponly: 1,
  samesite: 1,
  ...over,
});

describe('decryptChromeCookie', () => {
  it('turns a Chrome row into an Electron cookie, dropping the host hash newer Chrome prefixes', () => {
    const cookie = decryptChromeCookie(row(), chromeCookieKey('test-password'), 24);
    expect(cookie).toEqual({
      url: 'https://claude.ai/',
      domain: '.claude.ai',
      name: 'sessionKey',
      value: 'synthetic-value',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 13500000000 - 11644473600,
    });
  });

  it('reads older databases without the host prefix, host-only cookies without a domain, and session cookies without an expiry', () => {
    const cookie = decryptChromeCookie(
      row({ host_key: 'claude.ai', encrypted_value: encrypt('old', 'pw', 'claude.ai', 20), expires_s: 0, samesite: -1 }),
      chromeCookieKey('pw'),
      20
    );
    expect(cookie).toMatchObject({ url: 'https://claude.ai/', value: 'old', sameSite: 'unspecified' });
    expect(cookie).not.toHaveProperty('domain');
    expect(cookie).not.toHaveProperty('expirationDate');
  });

  it('skips values it cannot read', () => {
    expect(decryptChromeCookie(row({ encrypted_value: Buffer.from('plain') }), chromeCookieKey('test-password'), 24)).toBeNull();
  });
});

describe('jarCookieToSet', () => {
  it('turns a checked jar cookie back into one to set, keeping host-only cookies host-only', () => {
    expect(jarCookieToSet({ domain: '.google.com', name: 'SID', value: 'v', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: 5 })).toEqual({
      url: 'https://google.com/',
      domain: '.google.com',
      name: 'SID',
      value: 'v',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 5,
    });
    const hostOnly = jarCookieToSet({ domain: 'accounts.google.com', hostOnly: true, name: '__Host-GAPS', value: 'v', session: true, expirationDate: 9, sameSite: 'weird' });
    expect(hostOnly).toMatchObject({ url: 'https://accounts.google.com/', sameSite: 'unspecified' });
    expect(hostOnly).not.toHaveProperty('domain');
    expect(hostOnly).not.toHaveProperty('expirationDate');
    expect(jarCookieToSet({ name: 'x', value: 'y' })).toBeNull();
  });
});

describe('browsers and profiles (fixture data folders)', () => {
  const chrome = browserSpec('chrome');
  const google = ['docs.google.com', 'accounts.google.com', 'google.com'];
  const now = Date.now();
  let locked: string[] = [];
  afterEach(() => {
    for (const dir of locked.reverse()) chmodSync(dir, 0o755);
    locked = [];
  });

  function twoProfiles(root: string) {
    return writeBrowser(root, 'Google/Chrome', [
      {
        dir: 'Default',
        name: 'Personal',
        email: 'me@example.test',
        cookies: [
          { host: '.google.com', name: 'SID', value: 'personal-sid', lastAccess: now - 2 * 3_600_000 },
          { host: 'accounts.google.com', name: '__Host-GAPS', value: 'personal-gaps', lastAccess: now - 3_600_000 },
          { host: '.youtube.com', name: 'VISITOR', value: 'not-copied', lastAccess: now - 60_000 },
          { host: 'mail.google.com', name: 'OTHER', value: 'not-listed-host' },
          { host: '.google.com', name: 'OLD', value: 'expired', expires: now - 1_000 },
        ],
      },
      {
        dir: 'Profile 2',
        name: 'Work',
        email: 'you@work.example',
        cookies: [{ host: '.google.com', name: 'SID', value: 'work-sid', lastAccess: now - 3 * 86_400_000 }],
      },
      { dir: 'Profile 3', name: 'Empty' },
      { dir: 'Profile 4', name: 'Notion only', cookies: [{ host: '.notion.so', name: 'token_v2', value: 'n' }] },
    ]);
  }

  it('finds installed Chromium browsers by their data folder', () => {
    const root = fixtureRoot();
    expect(installedBrowsers(root)).toEqual([]);
    writeBrowser(root, 'Google/Chrome', []);
    writeBrowser(root, 'BraveSoftware/Brave-Browser', []);
    expect(installedBrowsers(root).map((b) => b.name)).toEqual(['Chrome', 'Brave']);
  });

  it('lists profiles from Local State with their names and accounts, in the browser\'s order', () => {
    const root = fixtureRoot();
    twoProfiles(root);
    expect(listProfiles(chrome, root)).toEqual([
      { browser: 'chrome', browserName: 'Chrome', dir: 'Default', name: 'Personal', email: 'me@example.test' },
      { browser: 'chrome', browserName: 'Chrome', dir: 'Profile 2', name: 'Work', email: 'you@work.example' },
      { browser: 'chrome', browserName: 'Chrome', dir: 'Profile 3', name: 'Empty', email: null },
      { browser: 'chrome', browserName: 'Chrome', dir: 'Profile 4', name: 'Notion only', email: null },
    ]);
  });

  it('says which profiles are signed in to a site, newest use first, hiding the others', () => {
    const root = fixtureRoot();
    twoProfiles(root);
    const found = profilesWithSignIn(google, root, now);
    expect(found.browsers).toEqual([{ id: 'chrome', name: 'Chrome' }]);
    expect(found.profiles.map((p) => [p.dir, p.name])).toEqual([
      ['Default', 'Personal'],
      ['Profile 2', 'Work'],
    ]);
    // Only the site's hosts count toward "last used": accounts.google.com an hour ago, not youtube's newer use.
    expect(Math.abs(found.profiles[0]!.lastUsedAt - (now - 3_600_000))).toBeLessThan(2);
    expect(found.denied).toEqual([]);
  });

  it('reports use and change times without the update column too (older databases, old file layout)', () => {
    const root = fixtureRoot();
    const created = now - 5 * 86_400_000;
    writeBrowser(root, 'Google/Chrome', [
      { dir: 'Default', name: 'P', legacyPath: true, noUpdateColumn: true, cookies: [{ host: 'claude.ai', name: 'sessionKey', value: 's', created }] },
    ]);
    const activity = siteActivity(chrome, 'Default', ['claude.ai'], root, now);
    expect(activity && Math.abs(activity.updatedAt - created)).toBeLessThan(2);
    expect(siteActivity(chrome, 'Default', ['notion.so'], root, now)).toBeNull();
    expect(siteActivity(chrome, 'Profile 9', ['claude.ai'], root, now)).toBeNull();
    expect(siteActivity(chrome, '../../etc', ['claude.ai'], root, now)).toBeNull();
  });

  it("reads and decrypts only the site's listed hosts, live rows only", () => {
    const root = fixtureRoot();
    twoProfiles(root);
    const cookies = readSiteCookies(chrome, 'Default', google, FIXTURE_PASSWORD, root, now);
    expect(cookies.map((c) => [c.url, c.name, c.value]).sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
      ['https://accounts.google.com/', '__Host-GAPS', 'personal-gaps'],
      ['https://google.com/', 'SID', 'personal-sid'],
    ]);
  });

  it('types its failures: not signed in, a wrong key, no browser', () => {
    const root = fixtureRoot();
    twoProfiles(root);
    const reason = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof SignInReadError ? error.reason : String(error);
      }
      return 'no error';
    };
    expect(reason(() => readSiteCookies(chrome, 'Profile 3', google, FIXTURE_PASSWORD, root, now))).toBe('not_signed_in');
    expect(reason(() => readSiteCookies(chrome, 'Profile 4', google, FIXTURE_PASSWORD, root, now))).toBe('not_signed_in');
    expect(reason(() => readSiteCookies(chrome, 'Default', google, 'wrong-password', root, now))).toBe('failed');
    expect(reason(() => profilesWithSignIn(google, fixtureRoot(), now))).toBe('no_browser');
  });

  it("reads macOS's Files & Folders refusal as folder_access_denied, in listing and in reading", () => {
    const root = fixtureRoot();
    const dir = twoProfiles(root);
    chmodSync(path.join(dir, 'Default', 'Network', 'Cookies'), 0o000);
    locked.push(path.join(dir, 'Default', 'Network', 'Cookies'));
    expect(() => readSiteCookies(chrome, 'Default', google, FIXTURE_PASSWORD, root, now)).toThrow(
      expect.objectContaining({ reason: 'folder_access_denied', browser: 'chrome' })
    );
    // The whole browser folder refused: still "installed", listing says denied.
    chmodSync(dir, 0o000);
    locked.push(dir);
    expect(installedBrowsers(root).map((b) => b.id)).toEqual(['chrome']);
    expect(() => listProfiles(chrome, root)).toThrow(expect.objectContaining({ reason: 'folder_access_denied' }));
    expect(() => profilesWithSignIn(google, root, now)).toThrow(expect.objectContaining({ reason: 'folder_access_denied', browser: 'chrome' }));
  });

  it('keeps other browsers usable when one is refused', () => {
    const root = fixtureRoot();
    const chromeDir = twoProfiles(root);
    writeBrowser(root, 'Arc/User Data', [{ dir: 'Default', name: 'Arc', cookies: [{ host: '.google.com', name: 'SID', value: 'arc' }] }]);
    chmodSync(chromeDir, 0o000);
    locked.push(chromeDir);
    const found = profilesWithSignIn(google, root, now);
    expect(found.denied).toEqual(['chrome']);
    expect(found.profiles.map((p) => [p.browserName, p.name])).toEqual([['Arc', 'Arc']]);
  });
});
