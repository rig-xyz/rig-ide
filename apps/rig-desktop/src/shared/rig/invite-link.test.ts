import { describe, expect, it } from 'vitest';
import { rigJoinPageUrl } from '@shared/urls';
import { extractInviteSecret, parseInviteLink } from './invite-link';

describe('extractInviteSecret', () => {
  it('pulls the secret out of the canonical join page URL', () => {
    expect(extractInviteSecret('https://userig.xyz/join/tap_inv_abc123')).toBe('tap_inv_abc123');
  });

  it('round-trips what rigJoinPageUrl produces, including characters it had to encode', () => {
    expect(extractInviteSecret(rigJoinPageUrl('tap_inv_a+b/c='))).toBe('tap_inv_a+b/c=');
  });

  it('accepts a bare host/path paste, surrounding whitespace, a trailing slash, and a query/hash', () => {
    expect(extractInviteSecret('userig.xyz/join/abc123')).toBe('abc123');
    expect(extractInviteSecret('  https://userig.xyz/join/abc123/  ')).toBe('abc123');
    expect(extractInviteSecret('https://userig.xyz/join/abc123?utm=mail#top')).toBe('abc123');
    expect(extractInviteSecret('https://USERIG.xyz/join/abc123')).toBe('abc123');
  });

  it('rejects anything that is not a single-secret join link on the rig host', () => {
    expect(extractInviteSecret('')).toBeNull();
    expect(extractInviteSecret('not a link')).toBeNull();
    expect(extractInviteSecret('https://evil.example/join/abc123')).toBeNull();
    expect(extractInviteSecret('https://userig.xyz/join')).toBeNull();
    expect(extractInviteSecret('https://userig.xyz/join/')).toBeNull();
    expect(extractInviteSecret('https://userig.xyz/join/abc/extra')).toBeNull();
    expect(extractInviteSecret('https://userig.xyz/pricing')).toBeNull();
    expect(extractInviteSecret('ftp://userig.xyz/join/abc123')).toBeNull();
    expect(extractInviteSecret('https://userig.xyz/join/%E0%A4%A')).toBeNull(); // malformed escape
  });
});

describe('parseInviteLink', () => {
  it('returns the normalized URL alongside the secret', () => {
    expect(parseInviteLink('userig.xyz/join/abc123')).toEqual({
      kind: 'invite',
      url: 'https://userig.xyz/join/abc123',
      secret: 'abc123',
    });
  });

  it('recognizes an organization invite, which is never taken as a space secret', () => {
    expect(parseInviteLink('https://userig.xyz/join/org/tok_9')).toEqual({
      kind: 'org',
      url: 'https://userig.xyz/join/org/tok_9',
      secret: 'tok_9',
    });
    expect(extractInviteSecret('https://userig.xyz/join/org/tok_9')).toBeNull();
  });
});
