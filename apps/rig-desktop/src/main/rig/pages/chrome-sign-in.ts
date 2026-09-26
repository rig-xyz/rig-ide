import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

/**
 * "Use your Chrome sign-in" (Dylan approved building this, 2026-09-26):
 * copies the person's existing Chrome session for ONE site into the pages
 * browser profile, so claude.ai or Google open signed in inside rig. Chrome
 * is where passkeys, 1Password and two-step work; Electron can't do passkeys
 * for third-party sites at all.
 *
 * Only ever runs on the person's click, one site at a time. macOS asks them
 * (Keychain prompt) before Chrome's cookie key is handed over. Only that
 * site's rows are read, straight from Chrome's database (read-only, no copy
 * of the file), and cookie values are never logged or kept anywhere but the
 * pages profile.
 */

export type SignInSite = 'claude' | 'google';

/** Chrome `host_key`s that belong to a site (a leading dot covers subdomains). */
export const SITE_HOSTS: Record<SignInSite, (host: string) => boolean> = {
  claude: (h) => h === 'claude.ai' || h === '.claude.ai',
  google: (h) => h === 'google.com' || h.endsWith('.google.com'),
};

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

const CHROME_DIR = path.join(homedir(), 'Library/Application Support/Google/Chrome');

/** Chrome's live cookie database for a profile, opened read-only without locking or copying it. */
function openCookies(file: string): DatabaseSync {
  return new DatabaseSync(`file:${file}?immutable=1`, { readOnly: true });
}

/** The Chrome profile that used this site most recently; only that site's rows are looked at. */
function profileFor(site: SignInSite): { profile: string; file: string } | null {
  let best: { profile: string; file: string; last: number } | null = null;
  for (const profile of ['Default', ...Array.from({ length: 30 }, (_, i) => `Profile ${i + 1}`)]) {
    const file = [path.join(CHROME_DIR, profile, 'Network/Cookies'), path.join(CHROME_DIR, profile, 'Cookies')].find((f) => existsSync(f));
    if (!file) continue;
    const db = openCookies(file);
    try {
      const rows = db.prepare('SELECT host_key, last_access_utc / 1000000 AS last FROM cookies').all() as unknown as { host_key: string; last: number }[];
      const last = Math.max(0, ...rows.filter((r) => SITE_HOSTS[site](r.host_key)).map((r) => r.last));
      if (last > 0 && (!best || last > best.last)) best = { profile, file, last };
    } finally {
      db.close();
    }
  }
  return best && { profile: best.profile, file: best.file };
}

export type ChromeSignInResult =
  | { ok: true; profile: string; imported: number }
  | { ok: false; reason: 'no_chrome' | 'not_signed_in' | 'keychain_denied' | 'failed' };

const execFileAsync = promisify(execFile);

/** Asks macOS for Chrome's cookie password; the person approves or denies the Keychain prompt. */
async function chromeSafeStoragePassword(): Promise<string> {
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage']);
  return stdout.trim();
}

export async function importChromeSignIn(site: SignInSite, setCookie: (cookie: CookieToSet) => Promise<void>): Promise<ChromeSignInResult> {
  if (!existsSync(CHROME_DIR)) return { ok: false, reason: 'no_chrome' };
  const found = profileFor(site);
  if (!found) return { ok: false, reason: 'not_signed_in' };
  let password: string;
  try {
    password = await chromeSafeStoragePassword();
  } catch {
    return { ok: false, reason: 'keychain_denied' };
  }
  const db = openCookies(found.file);
  try {
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined)?.value ?? 0);
    const rows = db
      .prepare('SELECT host_key, name, encrypted_value, path, expires_utc / 1000000 AS expires_s, is_secure, is_httponly, samesite FROM cookies')
      .all() as unknown as ChromeCookieRow[];
    const key = chromeCookieKey(password);
    let imported = 0;
    for (const row of rows) {
      if (!SITE_HOSTS[site](row.host_key)) continue;
      const cookie = decryptChromeCookie(row, key, version);
      if (!cookie) continue;
      try {
        await setCookie(cookie);
        imported++;
      } catch {
        // One cookie Electron refuses (an odd prefix or domain) doesn't stop the rest.
      }
    }
    return imported > 0 ? { ok: true, profile: found.profile, imported } : { ok: false, reason: 'not_signed_in' };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    db.close();
  }
}
