import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromeCookieKey, CHROMIUM_BROWSERS } from './chrome-sign-in';

/**
 * Test-only: a synthetic browser data folder (Local State + cookie
 * databases), encrypted the way Chrome does on macOS. No real browser or
 * Keychain data is ever involved.
 */

export const FIXTURE_PASSWORD = 'fixture-safe-storage';

/** Chrome's µs-since-1601 for an ms epoch, as a bigint (past JavaScript's safe integers). */
export function chromeTime(ms: number): bigint {
  return (BigInt(ms) + 11644473600000n) * 1000n;
}

export function encryptChromeValue(value: string, password: string, hostKey: string, dbVersion: number): Uint8Array {
  const plain = dbVersion >= 24 ? Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from(value)]) : Buffer.from(value);
  const cipher = createCipheriv('aes-128-cbc', chromeCookieKey(password), Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

export interface FixtureCookie {
  host: string;
  name: string;
  value: string;
  path?: string;
  /** ms epoch; 0 for a session cookie. */
  expires?: number;
  lastAccess?: number;
  created?: number;
  updated?: number;
}

export interface FixtureProfile {
  dir: string;
  name: string;
  email?: string;
  cookies?: FixtureCookie[];
  /** Old layout: `<profile>/Cookies` rather than `<profile>/Network/Cookies`. */
  legacyPath?: boolean;
  /** Leave out `last_update_utc` (older databases). */
  noUpdateColumn?: boolean;
  /** ms epoch the browser last had the profile open (`active_time`, stored in seconds). */
  activeAt?: number;
}

/** A temporary "Application Support" folder (with a space in its path, like the real one). */
export function fixtureRoot(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'rig-sign-in-')), 'Application Support');
  mkdirSync(root, { recursive: true });
  return root;
}

/** The fixture's Applications folder, beside its "Application Support". */
export function fixtureApps(root: string): string[] {
  return [path.join(path.dirname(root), 'Applications')];
}

/** Puts a browser's app bundle in the fixture's Applications folder: installed. */
export function installApp(root: string, dataDir: string): void {
  const spec = CHROMIUM_BROWSERS.find((b) => b.dataDir === dataDir)!;
  mkdirSync(path.join(fixtureApps(root)[0]!, spec.app), { recursive: true });
}

/** A browser's data folder; installed too unless `installed: false` (data left behind by a removed app). */
export function writeBrowser(
  root: string,
  dataDir: string,
  profiles: FixtureProfile[],
  opts: { password?: string; dbVersion?: number; installed?: boolean } = {}
): string {
  if (opts.installed !== false) installApp(root, dataDir);
  const dir = path.join(root, dataDir);
  mkdirSync(dir, { recursive: true });
  const infoCache = Object.fromEntries(
    profiles.map((p) => [
      p.dir,
      {
        name: p.name,
        ...(p.email ? { user_name: p.email, gaia_name: p.name } : { user_name: '' }),
        ...(p.activeAt ? { active_time: p.activeAt / 1000 } : {}),
      },
    ])
  );
  writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache, profiles_order: profiles.map((p) => p.dir), last_used: profiles[0]?.dir } }));
  const version = opts.dbVersion ?? 24;
  for (const p of profiles) {
    if (!p.cookies) continue;
    const file = p.legacyPath ? path.join(dir, p.dir, 'Cookies') : path.join(dir, p.dir, 'Network', 'Cookies');
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', String(version));
    db.exec(
      `CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
        expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, samesite INTEGER${p.noUpdateColumn ? '' : ', last_update_utc INTEGER'})`
    );
    const now = Date.now();
    for (const c of p.cookies) {
      const cols = [
        chromeTime(c.created ?? now - 86_400_000),
        c.host,
        c.name,
        '',
        encryptChromeValue(c.value, opts.password ?? FIXTURE_PASSWORD, c.host, version),
        c.path ?? '/',
        c.expires === 0 ? 0 : chromeTime(c.expires ?? now + 30 * 86_400_000),
        1,
        1,
        chromeTime(c.lastAccess ?? now - 3_600_000),
        1,
      ];
      if (p.noUpdateColumn) db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...cols);
      else db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...cols, chromeTime(c.updated ?? c.created ?? now - 86_400_000));
    }
    db.close();
  }
  return dir;
}
