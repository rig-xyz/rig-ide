import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chromeCookieKey, decryptChromeCookie, SITE_HOSTS, type ChromeCookieRow } from './chrome-sign-in';

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

describe('SITE_HOSTS', () => {
  it('takes only the chosen site\'s cookies', () => {
    expect(['claude.ai', '.claude.ai'].every(SITE_HOSTS.claude)).toBe(true);
    expect(['.anthropic.com', 'claude.ai.evil.com', '.google.com'].some(SITE_HOSTS.claude)).toBe(false);
    expect(['.google.com', 'docs.google.com', 'accounts.google.com'].every(SITE_HOSTS.google)).toBe(true);
    expect(['google.com.evil.io', '.youtube.com', '.claude.ai'].some(SITE_HOSTS.google)).toBe(false);
  });
});
