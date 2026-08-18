import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './externalLinks';

describe('isHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com/path?query=1#frag')).toBe(true);
  });

  it('rejects every other scheme — the same allowlist appService.openExternal enforces', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('mailto:someone@example.com')).toBe(false);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects a bare relative path or garbage string — never throws', () => {
    expect(isHttpUrl('CLAUDE.md')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});
