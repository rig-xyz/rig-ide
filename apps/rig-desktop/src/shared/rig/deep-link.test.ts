import { describe, expect, it } from 'vitest';
import { findRigUrlInArgv, parseRigDeepLink, toJoinRequest } from './deep-link';

// The relay's real shape: `tap_inv_` + 32 base64url chars.
const SECRET = 'tap_inv_Ab3-_x9QwErTyUiOpAsDfGhJkLzXcVbN';

describe('parseRigDeepLink', () => {
  it('accepts rig://join/<secret>', () => {
    expect(parseRigDeepLink(`rig://join/${SECRET}`)).toEqual({ kind: 'join', secret: SECRET });
  });

  it('tolerates a trailing slash, surrounding whitespace, and a case-folded scheme/host', () => {
    expect(parseRigDeepLink(`rig://join/${SECRET}/`)).toEqual({ kind: 'join', secret: SECRET });
    expect(parseRigDeepLink(`  rig://join/${SECRET}\n`)).toEqual({ kind: 'join', secret: SECRET });
    expect(parseRigDeepLink(`RIG://JOIN/${SECRET}`)).toEqual({ kind: 'join', secret: SECRET });
  });

  it('keeps the secret case-sensitive', () => {
    expect(parseRigDeepLink(`rig://join/${SECRET}`)?.secret).not.toBe(SECRET.toLowerCase());
  });

  it('rejects other schemes', () => {
    expect(parseRigDeepLink(`https://join/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`https://userig.xyz/join/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rigs://join/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig:join/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig:/join/${SECRET}`)).toBeNull();
  });

  it('rejects other hosts and paths', () => {
    expect(parseRigDeepLink(`rig://open/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig://joiner/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig:///join/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig://user@join/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig://join:443/${SECRET}`)).toBeNull();
    expect(parseRigDeepLink(`rig://evil.example/join/${SECRET}`)).toBeNull();
  });

  it('rejects a missing or malformed secret', () => {
    expect(parseRigDeepLink('rig://join')).toBeNull();
    expect(parseRigDeepLink('rig://join/')).toBeNull();
    expect(parseRigDeepLink('rig://join//')).toBeNull();
    expect(parseRigDeepLink('rig://join/abc123')).toBeNull(); // no tap_inv_ prefix
    expect(parseRigDeepLink('rig://join/tap_inv_short')).toBeNull(); // too short
    expect(parseRigDeepLink(`rig://join/tap_inv_${'a'.repeat(129)}`)).toBeNull(); // too long
    expect(parseRigDeepLink('rig://join/tap_inv_Ab3%2Fx9QwErTyUiOpAsDfGhJkLzXcVbN')).toBeNull(); // escapes
    expect(parseRigDeepLink('rig://join/tap_inv_Ab3.x9QwErTyUiOpAsDfGhJkLzXcVbN')).toBeNull();
    expect(parseRigDeepLink('rig://join/tap_inv_Ab3 x9QwErTyUiOpAsDfGhJkLzXcVbN')).toBeNull();
  });

  it('rejects extra segments, a query, or a fragment', () => {
    expect(parseRigDeepLink(`rig://join/${SECRET}/extra`)).toBeNull();
    expect(parseRigDeepLink(`rig://join/${SECRET}//`)).toBeNull();
    expect(parseRigDeepLink(`rig://join/${SECRET}?next=https://evil.example`)).toBeNull();
    expect(parseRigDeepLink(`rig://join/${SECRET}#frag`)).toBeNull();
  });

  it('rejects empty and non-URL input', () => {
    expect(parseRigDeepLink('')).toBeNull();
    expect(parseRigDeepLink('   ')).toBeNull();
    expect(parseRigDeepLink('not a link')).toBeNull();
  });
});

describe('findRigUrlInArgv', () => {
  it('finds the rig:// argument among the executable path and flags', () => {
    expect(
      findRigUrlInArgv([
        'C:\\Rig\\Rig.exe',
        '--allow-file-access-from-files',
        `rig://join/${SECRET}`,
      ])
    ).toBe(`rig://join/${SECRET}`);
    expect(findRigUrlInArgv(['/usr/bin/electron', '.', `RIG://join/${SECRET}`])).toBe(
      `RIG://join/${SECRET}`
    );
  });

  it('is null when no argument is a rig:// URL', () => {
    expect(findRigUrlInArgv([])).toBeNull();
    expect(
      findRigUrlInArgv(['/Applications/Rig.app/Contents/MacOS/Rig', '--foo', 'https://userig.xyz'])
    ).toBeNull();
  });
});

describe('toJoinRequest', () => {
  it('re-expresses the secret as the canonical https join link', () => {
    expect(toJoinRequest({ kind: 'join', secret: SECRET })).toEqual({
      link: `https://userig.xyz/join/${SECRET}`,
    });
  });
});
