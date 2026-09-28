import { describe, expect, it } from 'vitest';
import {
  cookieHostKeys,
  cookieHostMatches,
  DEFAULT_PAGE_SIGN_INS,
  isSignInWall,
  normalizePageSignIns,
  notSignedInForAgent,
  registrableDomain,
  signInSiteFor,
  signInSiteForUrl,
} from './sign-in-sites';

describe('registrableDomain', () => {
  it.each([
    ['docs.google.com', 'google.com'],
    ['google.com', 'google.com'],
    ['www.notion.so', 'notion.so'],
    ['preview.claude.ai', 'claude.ai'],
    ['a.b.example.co.uk', 'example.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['news.bbc.co.uk', 'bbc.co.uk'],
    ['team.github.io', 'team.github.io'],
    ['app.team.vercel.app', 'team.vercel.app'],
    ['Docs.Google.COM.', 'google.com'],
    ['localhost', 'localhost'],
    ['10.0.0.2', '10.0.0.2'],
    ['example.de', 'example.de'],
    ['a.example.io', 'example.io'],
  ])('%s → %s', (host, domain) => {
    expect(registrableDomain(host)).toBe(domain);
  });
});

describe('sign-in sites', () => {
  it('knows the hosts a sign-in lives on for known sites', () => {
    expect(signInSiteForUrl('https://docs.google.com/document/d/abc/edit')).toEqual({
      id: 'google.com',
      name: 'Google',
      hosts: ['docs.google.com', 'accounts.google.com', 'google.com'],
      checkUrl: 'https://docs.google.com/document/u/0/',
    });
    expect(signInSiteForUrl('https://claude.ai/public/artifacts/x')).toMatchObject({ id: 'claude.ai', name: 'Claude', hosts: ['claude.ai'] });
    expect(signInSiteForUrl('https://www.notion.so/Roadmap-123')?.hosts).toEqual(['notion.so', 'www.notion.so']);
  });

  it('works for any other site: its domain, www., and the page host', () => {
    expect(signInSiteForUrl('https://dash.internal.acme.dev/q4')).toEqual({
      id: 'acme.dev',
      name: 'acme.dev',
      hosts: ['acme.dev', 'www.acme.dev', 'dash.internal.acme.dev'],
      checkUrl: 'https://dash.internal.acme.dev/',
    });
    expect(signInSiteFor('acme.dev').hosts).toEqual(['acme.dev', 'www.acme.dev']);
  });

  it('is null for what is not a signable web page', () => {
    expect(signInSiteForUrl('file:///etc/hosts')).toBeNull();
    expect(signInSiteForUrl('http://localhost:3000/')).toBeNull();
    expect(signInSiteForUrl('http://127.0.0.1/')).toBeNull();
    expect(signInSiteForUrl('not a url')).toBeNull();
  });

  it("matches exactly the listed hosts' cookies (h and .h), nothing else", () => {
    const hosts = ['docs.google.com', 'accounts.google.com', 'google.com'];
    expect(['.google.com', 'google.com', 'docs.google.com', '.docs.google.com', 'accounts.google.com'].every((h) => cookieHostMatches(h, hosts))).toBe(true);
    expect(['mail.google.com', '.youtube.com', 'google.com.evil.io', '.claude.ai', 'evilgoogle.com'].some((h) => cookieHostMatches(h, hosts))).toBe(false);
    expect(cookieHostKeys(['claude.ai'])).toEqual(['claude.ai', '.claude.ai']);
  });
});

describe('isSignInWall', () => {
  it('spots a redirect to a sign-in host, a sign-in path, or a password field', () => {
    expect(isSignInWall({ url: 'https://accounts.google.com/v3/signin/identifier?continue=x' })).toBe(true);
    expect(isSignInWall({ url: 'https://acme.okta.com/app/x' })).toBe(true);
    expect(isSignInWall({ url: 'https://claude.ai/login?returnTo=%2Fchat' })).toBe(true);
    expect(isSignInWall({ url: 'https://www.notion.so/login' })).toBe(true);
    expect(isSignInWall({ url: 'https://slack.com/signin' })).toBe(true);
    expect(isSignInWall({ url: 'https://gitlab.example.com/users/sign_in' })).toBe(true);
    expect(isSignInWall({ url: 'https://dash.acme.dev/q4', hasPasswordField: true })).toBe(true);
  });

  it('leaves ordinary pages alone', () => {
    expect(isSignInWall({ url: 'https://docs.google.com/document/d/abc/edit' })).toBe(false);
    expect(isSignInWall({ url: 'https://claude.ai/public/artifacts/abc' })).toBe(false);
    expect(isSignInWall({ url: 'https://blog.example.com/how-to-login-faster' })).toBe(false);
    expect(isSignInWall({ url: 'https://example.com/sessions-2026' })).toBe(false);
    expect(isSignInWall({ url: 'nope' })).toBe(false);
  });
});

describe('notSignedInForAgent', () => {
  it("names the host and the owner, never the page's HTML", () => {
    const text = notSignedInForAgent('https://docs.google.com/document/d/abc', null);
    expect(text).toContain('Not signed in to docs.google.com as the owner');
    expect(notSignedInForAgent('https://docs.google.com/x', { siteName: 'Google', account: 'me@example.test' })).toContain(
      "rig's copy of their Google sign-in (me@example.test) was refused or has expired"
    );
  });
});

describe('normalizePageSignIns', () => {
  const record = {
    site: 'google.com',
    siteName: 'Google',
    browser: 'chrome',
    browserName: 'Chrome',
    profile: 'Default',
    profileName: 'Personal',
    account: 'me@example.test',
    hosts: ['docs.google.com', 'google.com'],
    checkUrl: 'https://docs.google.com/document/d/abc',
    importedAt: 1,
    sourceUpdatedAt: 2,
    expired: true,
  };

  it('keeps well-formed state', () => {
    const state = {
      sites: { 'google.com': record },
      keepInStep: true,
      access: { chrome: { folder: 'granted', keychain: 'silent' } },
      connection: { browser: 'chrome', browserName: 'Chrome', profile: 'Default', profileName: 'Personal', email: 'me@example.test', connectedAt: 5 },
    };
    expect(normalizePageSignIns(state)).toEqual(state);
  });

  it('reads a malformed or missing connection as not connected', () => {
    expect(normalizePageSignIns({ sites: {} }).connection).toBeNull();
    expect(normalizePageSignIns({ connection: { browser: 'netscape', profile: 'Default' } }).connection).toBeNull();
    expect(normalizePageSignIns({ connection: { browser: 'chrome', profile: '' } }).connection).toBeNull();
    expect(normalizePageSignIns({ connection: { browser: 'arc', profile: 'Default' } }).connection).toMatchObject({ browserName: 'arc', email: null });
  });

  it('drops what is malformed instead of failing', () => {
    expect(normalizePageSignIns(undefined)).toEqual(DEFAULT_PAGE_SIGN_INS);
    expect(normalizePageSignIns('x')).toEqual(DEFAULT_PAGE_SIGN_INS);
    const state = normalizePageSignIns({
      sites: { 'google.com': record, 'claude.ai': { ...record, site: 'claude.ai', browser: 'netscape' }, 'x.com': { ...record } },
      keepInStep: 'yes',
      access: { chrome: { folder: 'maybe', keychain: 'silent' }, lynx: { folder: 'granted' } },
    });
    expect(Object.keys(state.sites)).toEqual(['google.com']);
    expect(state.keepInStep).toBe(false);
    expect(state.access).toEqual({ chrome: { folder: 'unknown', keychain: 'silent' } });
  });
});
