import { describe, expect, it } from 'vitest';
import { isAssetDownloadUrl } from './auth';

/**
 * An agent CLI's login output is scanned for the first URL, which is then
 * offered to the user as "open this to sign in". Some CLIs bootstrap
 * themselves first and print a download URL before any auth URL — Claude Code
 * fetches a Bun binary from GitHub releases on first run — so the first URL is
 * not reliably the login one.
 */
describe('isAssetDownloadUrl', () => {
  it('rejects the binary downloads agent CLIs print while bootstrapping', () => {
    expect(
      isAssetDownloadUrl(
        'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-x64-baseline.zip'
      )
    ).toBe(true);
    expect(isAssetDownloadUrl('https://example.com/agent.tar.gz')).toBe(true);
    expect(isAssetDownloadUrl('https://example.com/installer.dmg')).toBe(true);
    expect(isAssetDownloadUrl('https://example.com/setup.exe')).toBe(true);
  });

  it('keeps real login URLs, including ones with query strings and fragments', () => {
    expect(isAssetDownloadUrl('https://claude.ai/oauth/authorize?code=abc')).toBe(false);
    expect(isAssetDownloadUrl('https://example.com/login')).toBe(false);
    expect(isAssetDownloadUrl('https://auth.example.com/device?user_code=WXYZ')).toBe(false);
    // The extension test reads the path only, so a login URL that merely
    // mentions an archive in its query is still a login URL.
    expect(isAssetDownloadUrl('https://example.com/login?next=/downloads/app.zip')).toBe(false);
  });

  it('treats an unparseable URL as not-an-asset rather than throwing', () => {
    expect(isAssetDownloadUrl('not a url')).toBe(false);
  });
});
