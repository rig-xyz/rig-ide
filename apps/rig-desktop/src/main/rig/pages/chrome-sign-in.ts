import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  cookieHostKeys,
  type BrowserId,
  type BrowserProfileInfo,
  type ProfileWithSignIn,
  type SignInFailureReason,
} from '@shared/pages/sign-in-sites';

/**
 * "Use your Chrome sign-in" for any site (canvas board 18): reading ONE
 * site's sign-in from a Chromium browser's profile, so a page beside the
 * chat opens signed in inside rig. Chrome is where passkeys, 1Password and
 * two-step work; Electron can't do passkeys for third-party sites at all.
 *
 * - Profiles come from the browser's own `Local State` list (names and
 *   account emails); no cookie is read to list them.
 * - For a site, only its hosts' rows are looked at: `host_key` and
 *   `last_access_utc` to say which profiles are signed in, and the values
 *   only once the person picked a profile and macOS handed over the key.
 * - Databases are opened read-only without locking or copying them; cookie
 *   values are never logged or kept anywhere but the pages profile.
 *
 * Only ever runs on the person's click, or for a site they already approved
 * ("Keep in step"), and never so that macOS would ask unannounced.
 */

export interface ChromeCookieRow {
  host_key: string;
  name: string;
  encrypted_value: Uint8Array;
  path: string;
  /** Seconds since 1601 (Chrome's epoch); 0 for a session cookie. */
  expires_s: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

export interface CookieToSet {
  url: string;
  domain?: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

/** Seconds between 1601-01-01 (Chrome) and 1970-01-01 (Unix). */
const CHROME_EPOCH_OFFSET_S = 11644473600;

/** Chrome's macOS cookie key, derived from its "Chrome Safe Storage" password. */
export function chromeCookieKey(safeStoragePassword: string): Buffer {
  return pbkdf2Sync(safeStoragePassword, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * One Chrome cookie row as an Electron cookie, or null when it isn't one we
 * can read (not "v10"). From database version 24 Chrome prefixes the value
 * with the SHA-256 of its host, which is dropped.
 */
export function decryptChromeCookie(row: ChromeCookieRow, key: Buffer, dbVersion: number): CookieToSet | null {
  const enc = Buffer.from(row.encrypted_value);
  if (enc.subarray(0, 3).toString() !== 'v10') return null;
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  let value = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
  if (dbVersion >= 24) value = value.subarray(32);
  const host = row.host_key.replace(/^\./, '');
  return {
    url: `https://${host}${row.path}`,
    ...(row.host_key.startsWith('.') ? { domain: row.host_key } : {}),
    name: row.name,
    value: value.toString('utf8'),
    path: row.path,
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite: (['no_restriction', 'lax', 'strict'] as const)[row.samesite] ?? 'unspecified',
    ...(row.expires_s > 0 ? { expirationDate: row.expires_s - CHROME_EPOCH_OFFSET_S } : {}),
  };
}

/** A cookie as Electron's cookie jar lists it, turned back into one to set elsewhere (the checked copy → the pages profile). */
export interface JarCookie {
  domain?: string;
  hostOnly?: boolean;
  name: string;
  value: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  session?: boolean;
  expirationDate?: number;
}

const SAME_SITES = ['unspecified', 'no_restriction', 'lax', 'strict'] as const;

export function jarCookieToSet(c: JarCookie): CookieToSet | null {
  if (!c.domain) return null;
  const host = c.domain.replace(/^\./, '');
  const cookiePath = c.path || '/';
  return {
    url: `https://${host}${cookiePath}`,
    ...(c.hostOnly ? {} : { domain: `.${host}` }),
    name: c.name,
    value: c.value,
    path: cookiePath,
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: SAME_SITES.find((s) => s === c.sameSite) ?? 'unspecified',
    ...(c.expirationDate && !c.session ? { expirationDate: c.expirationDate } : {}),
  };
}

// ---- Browsers and profiles -------------------------------------------------

export interface BrowserSpec {
  id: BrowserId;
  /** As the person knows it: "Chrome", "Arc". */
  name: string;
  /** Its data folder, under ~/Library/Application Support. */
  dataDir: string;
  /** The Keychain item holding its cookie password. */
  keychainService: string;
  /** For "Open in <browser>". */
  bundleId: string;
}

/** Chromium browsers on macOS: same cookie database, each with its own Keychain item. */
export const CHROMIUM_BROWSERS: readonly BrowserSpec[] = [
  { id: 'chrome', name: 'Chrome', dataDir: 'Google/Chrome', keychainService: 'Chrome Safe Storage', bundleId: 'com.google.Chrome' },
  { id: 'arc', name: 'Arc', dataDir: 'Arc/User Data', keychainService: 'Arc Safe Storage', bundleId: 'company.thebrowser.Browser' },
  { id: 'brave', name: 'Brave', dataDir: 'BraveSoftware/Brave-Browser', keychainService: 'Brave Safe Storage', bundleId: 'com.brave.Browser' },
  { id: 'edge', name: 'Edge', dataDir: 'Microsoft Edge', keychainService: 'Microsoft Edge Safe Storage', bundleId: 'com.microsoft.edgemac' },
  { id: 'chromium', name: 'Chromium', dataDir: 'Chromium', keychainService: 'Chromium Safe Storage', bundleId: 'org.chromium.Chromium' },
  { id: 'vivaldi', name: 'Vivaldi', dataDir: 'Vivaldi', keychainService: 'Vivaldi Safe Storage', bundleId: 'com.vivaldi.Vivaldi' },
];

export function browserSpec(id: BrowserId): BrowserSpec {
  return CHROMIUM_BROWSERS.find((b) => b.id === id)!;
}

/** Where browsers keep their data; tests point this at fixtures. */
export const APP_SUPPORT = path.join(homedir(), 'Library/Application Support');

/** A read that stopped for a reason the person can act on. */
export class SignInReadError extends Error {
  constructor(
    readonly reason: SignInFailureReason,
    readonly browser?: BrowserId
  ) {
    super(reason);
    this.name = 'SignInReadError';
  }
}

/** macOS "access data from other apps" refused (Files & Folders): opening fails with EPERM/EACCES. */
export function isAccessDenied(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

function readError(error: unknown, browser: BrowserId): SignInReadError {
  if (error instanceof SignInReadError) return error;
  return new SignInReadError(isAccessDenied(error) ? 'folder_access_denied' : 'failed', browser);
}

function browserDir(browser: BrowserSpec, root: string): string {
  return path.join(root, browser.dataDir);
}

/**
 * Installed Chromium browsers, by their data folder. A folder macOS won't
 * let rig into still counts: that's a permission to ask for, not a missing
 * browser.
 */
export function installedBrowsers(root = APP_SUPPORT): BrowserSpec[] {
  return CHROMIUM_BROWSERS.filter((b) => {
    try {
      return statSync(browserDir(b, root)).isDirectory();
    } catch (error) {
      return isAccessDenied(error);
    }
  });
}

/** A profile folder name from `Local State` that is safe to join onto a path. */
function isProfileDir(dir: string): boolean {
  return /^[^/\\]+$/.test(dir) && dir !== '.' && dir !== '..';
}

interface LocalStateProfile {
  name?: unknown;
  user_name?: unknown;
}

/** The browser's own profile list, from `Local State`: names and account emails only, no cookies. */
export function listProfiles(browser: BrowserSpec, root = APP_SUPPORT): BrowserProfileInfo[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(browserDir(browser, root), 'Local State'), 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw readError(error, browser.id);
  }
  let profile: { info_cache?: unknown; profiles_order?: unknown } | undefined;
  try {
    profile = (JSON.parse(raw) as { profile?: typeof profile } | null)?.profile;
  } catch {
    throw new SignInReadError('failed', browser.id);
  }
  const cache = (profile?.info_cache && typeof profile.info_cache === 'object' ? profile.info_cache : {}) as Record<string, LocalStateProfile>;
  const order = Array.isArray(profile?.profiles_order) ? profile.profiles_order.filter((d): d is string => typeof d === 'string') : [];
  const dirs = [...order.filter((d) => d in cache), ...Object.keys(cache).filter((d) => !order.includes(d))].filter(isProfileDir);
  return dirs.map((dir) => {
    const p = cache[dir] ?? {};
    return {
      browser: browser.id,
      browserName: browser.name,
      dir,
      name: typeof p.name === 'string' && p.name ? p.name : dir,
      email: typeof p.user_name === 'string' && p.user_name ? p.user_name : null,
    };
  });
}

// ---- One site's cookies ----------------------------------------------------

/** A profile's cookie database, or null when it has none; opening it first so a macOS refusal reads as one. */
function cookiesFile(browser: BrowserSpec, profileDir: string, root: string): string | null {
  if (!isProfileDir(profileDir)) return null;
  for (const rel of ['Network/Cookies', 'Cookies']) {
    const file = path.join(browserDir(browser, root), profileDir, rel);
    try {
      closeSync(openSync(file, 'r'));
      return file;
    } catch (error) {
      if (isAccessDenied(error)) throw new SignInReadError('folder_access_denied', browser.id);
    }
  }
  return null;
}

/** The live database, opened read-only without locking or copying it. */
function withCookies<T>(browser: BrowserSpec, file: string, read: (db: DatabaseSync) => T): T {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  } catch (error) {
    throw readError(error, browser.id);
  }
  try {
    return read(db);
  } catch (error) {
    throw readError(error, browser.id);
  } finally {
    db.close();
  }
}

const inHosts = (hosts: readonly string[]) => {
  const keys = cookieHostKeys(hosts);
  return { sql: `host_key IN (${keys.map(() => '?').join(', ')})`, keys };
};
/** Rows still alive: session cookies, or an expiry (seconds since 1601) after now. */
const ALIVE = '(expires_utc = 0 OR expires_utc / 1000000 > ?)';
const chromeNowS = (now: number) => Math.floor(now / 1000) + CHROME_EPOCH_OFFSET_S;
/** Chrome's µs-since-1601 as ms since 1970, computed in SQL (the raw value is past JavaScript's safe integers). */
const toMs = (column: string) => `(${column} / 1000 - ${CHROME_EPOCH_OFFSET_S * 1000})`;

export interface SiteActivity {
  /** ms epoch of the newest use of any of the site's cookies. */
  lastUsedAt: number;
  /** ms epoch of the newest change to them ("Keep in step" compares this). */
  updatedAt: number;
}

/**
 * Whether a profile holds a live sign-in for these hosts, and when it was
 * last used and changed. Reads `host_key` and timestamps only, never values.
 */
export function siteActivity(browser: BrowserSpec, profileDir: string, hosts: readonly string[], root = APP_SUPPORT, now = Date.now()): SiteActivity | null {
  const file = cookiesFile(browser, profileDir, root);
  if (!file) return null;
  return withCookies(browser, file, (db) => {
    const columns = new Set((db.prepare('PRAGMA table_info(cookies)').all() as { name: string }[]).map((c) => c.name));
    const changed = columns.has('last_update_utc') ? 'MAX(creation_utc, last_update_utc)' : 'creation_utc';
    const where = inHosts(hosts);
    const row = db
      .prepare(`SELECT COUNT(*) AS n, MAX(${toMs('last_access_utc')}) AS used, MAX(${toMs(changed)}) AS changed FROM cookies WHERE ${where.sql} AND ${ALIVE}`)
      .get(...where.keys, chromeNowS(now)) as { n: number; used: number | null; changed: number | null };
    return row.n > 0 ? { lastUsedAt: row.used ?? 0, updatedAt: row.changed ?? 0 } : null;
  });
}

export interface SitePresence {
  browsers: { id: BrowserId; name: string }[];
  /** Profiles signed in to the site, most recently used first. Profiles without it are left out. */
  profiles: (ProfileWithSignIn & { updatedAt: number })[];
  /** Browsers macOS didn't let rig read (Files & Folders). */
  denied: BrowserId[];
}

/**
 * Which profiles, in every installed Chromium browser, are signed in to a
 * site. Throws `no_browser` with none installed, and `folder_access_denied`
 * when macOS refused every one of them.
 */
export function profilesWithSignIn(hosts: readonly string[], root = APP_SUPPORT, now = Date.now()): SitePresence {
  const browsers = installedBrowsers(root);
  if (browsers.length === 0) throw new SignInReadError('no_browser');
  const out: SitePresence = { browsers: browsers.map((b) => ({ id: b.id, name: b.name })), profiles: [], denied: [] };
  for (const browser of browsers) {
    try {
      for (const profile of listProfiles(browser, root)) {
        const activity = siteActivity(browser, profile.dir, hosts, root, now);
        if (activity) out.profiles.push({ ...profile, ...activity });
      }
    } catch (error) {
      if (readError(error, browser.id).reason === 'folder_access_denied') out.denied.push(browser.id);
      // Any other unreadable browser is left out; the others still count.
    }
  }
  if (out.denied.length === browsers.length) throw new SignInReadError('folder_access_denied', out.denied[0]);
  out.profiles.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return out;
}

/**
 * The site's cookies from one profile, decrypted with the browser's key:
 * only its hosts' rows, only live ones. `not_signed_in` when there are
 * none; `failed` when none could be decrypted (a wrong key).
 */
export function readSiteCookies(browser: BrowserSpec, profileDir: string, hosts: readonly string[], password: string, root = APP_SUPPORT, now = Date.now()): CookieToSet[] {
  const file = cookiesFile(browser, profileDir, root);
  if (!file) throw new SignInReadError('not_signed_in', browser.id);
  return withCookies(browser, file, (db) => {
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined)?.value ?? 0);
    const where = inHosts(hosts);
    const rows = db
      .prepare(
        `SELECT host_key, name, encrypted_value, path, expires_utc / 1000000 AS expires_s, is_secure, is_httponly, samesite FROM cookies WHERE ${where.sql} AND ${ALIVE}`
      )
      .all(...where.keys, chromeNowS(now)) as unknown as ChromeCookieRow[];
    if (rows.length === 0) throw new SignInReadError('not_signed_in', browser.id);
    const key = chromeCookieKey(password);
    const cookies: CookieToSet[] = [];
    for (const row of rows) {
      try {
        const cookie = decryptChromeCookie(row, key, version);
        if (cookie) cookies.push(cookie);
      } catch {
        // A row this key can't open is skipped; none at all is a wrong key.
      }
    }
    if (cookies.length === 0) throw new SignInReadError('failed', browser.id);
    return cookies;
  });
}

// ---- The Keychain ----------------------------------------------------------

/** A Keychain read that came back quicker than this didn't show a prompt: the person chose Always Allow. */
export const KEYCHAIN_SILENT_MS = 800;

export interface KeychainRead {
  password: string;
  /** Answered without asking the person. */
  silent: boolean;
}

/**
 * The browser's cookie password from the Keychain. macOS asks the person
 * unless they chose Always Allow before. `timeoutMs` bounds a read that
 * must not ask (it is stopped, and reads as `keychain_denied`); `signal`
 * is the sheet's Cancel.
 */
export function readKeychainPassword(browser: BrowserSpec, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<KeychainRead> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-w', '-s', browser.keychainService],
      { signal: opts.signal, timeout: opts.timeoutMs ?? 0 },
      (error, stdout) => {
        if (!error) return resolve({ password: String(stdout).trim(), silent: Date.now() - started < KEYCHAIN_SILENT_MS });
        if (opts.signal?.aborted) return reject(new SignInReadError('cancelled', browser.id));
        // 44: no such item (the browser never stored a cookie key).
        if ((error as { code?: unknown }).code === 44) return reject(new SignInReadError('failed', browser.id));
        reject(new SignInReadError('keychain_denied', browser.id));
      }
    );
  });
}
