import { describe, expect, it } from 'vitest';
import { normalizeJoinLink } from './join-link';

describe('normalizeJoinLink', () => {
  it('accepts the canonical join page URL', () => {
    expect(normalizeJoinLink('https://userig.xyz/join/abc123')).toBe('https://userig.xyz/join/abc123');
  });

  it('accepts a bare host/path paste with no scheme', () => {
    expect(normalizeJoinLink('userig.xyz/join/abc123')).toBe('https://userig.xyz/join/abc123');
  });

  it('rejects an empty or blank paste', () => {
    expect(normalizeJoinLink('')).toBeNull();
    expect(normalizeJoinLink('   ')).toBeNull();
  });

  it('rejects a link to a different host', () => {
    expect(normalizeJoinLink('https://evil.example/join/abc123')).toBeNull();
  });

  it('rejects the bare join page with no secret', () => {
    expect(normalizeJoinLink('https://userig.xyz/join')).toBeNull();
    expect(normalizeJoinLink('https://userig.xyz/join/')).toBeNull();
  });

  it('rejects a non-join page on the right host', () => {
    expect(normalizeJoinLink('https://userig.xyz/pricing')).toBeNull();
  });

  it('rejects a non-http(s) scheme', () => {
    expect(normalizeJoinLink('ftp://userig.xyz/join/abc123')).toBeNull();
  });
});
