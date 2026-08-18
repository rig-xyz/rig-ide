import { describe, expect, it } from 'vitest';
import {
  compareManifests,
  isManifestVersionAtLeast,
  parseUpdateManifest,
  sizeMatches,
  type UpdateManifest,
} from './manifest.ts';

/** A REAL manifest electron-builder generated from a local build (`release/v1-stable-mac.yml`, present in this repo at write time) — not a hand-invented fixture, so a format change in electron-builder's own output would actually be caught here. */
const REAL_MANIFEST = `version: 0.3.2
files:
  - url: rig-0.3.2-arm64.zip
    sha512: Pz05DR9Xl+Jc+zKSPIy32BAgGsihTIomJSrM6/Ui/llqolcgxszWEqQgWPNkgQvobfFozSj2MFHKHLpgAIlFYw==
    size: 215234129
  - url: rig-0.3.2-arm64.dmg
    sha512: SJIDlNCqK5TKpMP+CoSJ4ANXdqrqWu/vCU5XJODb0DwaeeXMsuEBIGqLffskFstLkoNaNFba7ac53t0syErHgg==
    size: 215185485
path: rig-0.3.2-arm64.zip
sha512: Pz05DR9Xl+Jc+zKSPIy32BAgGsihTIomJSrM6/Ui/llqolcgxszWEqQgWPNkgQvobfFozSj2MFHKHLpgAIlFYw==
releaseDate: '2026-08-18T00:04:28.621Z'
`;

describe('parseUpdateManifest', () => {
  it('parses a real electron-builder-generated manifest exactly', () => {
    expect(parseUpdateManifest(REAL_MANIFEST)).toEqual({
      version: '0.3.2',
      files: [
        {
          url: 'rig-0.3.2-arm64.zip',
          sha512: 'Pz05DR9Xl+Jc+zKSPIy32BAgGsihTIomJSrM6/Ui/llqolcgxszWEqQgWPNkgQvobfFozSj2MFHKHLpgAIlFYw==',
          size: 215234129,
        },
        {
          url: 'rig-0.3.2-arm64.dmg',
          sha512: 'SJIDlNCqK5TKpMP+CoSJ4ANXdqrqWu/vCU5XJODb0DwaeeXMsuEBIGqLffskFstLkoNaNFba7ac53t0syErHgg==',
          size: 215185485,
        },
      ],
      path: 'rig-0.3.2-arm64.zip',
      sha512: 'Pz05DR9Xl+Jc+zKSPIy32BAgGsihTIomJSrM6/Ui/llqolcgxszWEqQgWPNkgQvobfFozSj2MFHKHLpgAIlFYw==',
      releaseDate: '2026-08-18T00:04:28.621Z',
    });
  });

  it('parses a quoted releaseDate without the surrounding quotes', () => {
    const result = parseUpdateManifest(REAL_MANIFEST);
    expect(result.releaseDate).not.toMatch(/^['"]/);
  });

  it('carries blockMapSize through when the manifest includes it', () => {
    const withBlockMap = `version: 1.0.0
files:
  - url: rig-1.0.0-arm64.zip
    sha512: abc
    size: 100
    blockMapSize: 42
path: rig-1.0.0-arm64.zip
sha512: abc
releaseDate: '2026-01-01T00:00:00.000Z'
`;
    expect(parseUpdateManifest(withBlockMap).files[0]).toEqual({
      url: 'rig-1.0.0-arm64.zip',
      sha512: 'abc',
      size: 100,
      blockMapSize: 42,
    });
  });

  it('omits blockMapSize entirely when the manifest does not carry one (matches the real fixture above)', () => {
    expect(parseUpdateManifest(REAL_MANIFEST).files[0]).not.toHaveProperty('blockMapSize');
  });

  it('handles a single-file manifest (e.g. a linux AppImage-only channel) with no crash', () => {
    const single = `version: 2.0.0
files:
  - url: rig-2.0.0.AppImage
    sha512: xyz
    size: 500
path: rig-2.0.0.AppImage
sha512: xyz
releaseDate: '2026-02-02T00:00:00.000Z'
`;
    expect(parseUpdateManifest(single).files).toHaveLength(1);
  });

  it('throws on a manifest with no version — never returns a half-populated object silently', () => {
    expect(() => parseUpdateManifest('files:\n  - url: x\n    sha512: y\n    size: 1\n')).toThrow(/version/i);
  });

  it('throws on a files[] entry missing sha512', () => {
    const malformed = `version: 1.0.0
files:
  - url: rig-1.0.0.zip
    size: 100
`;
    expect(() => parseUpdateManifest(malformed)).toThrow(/Malformed/);
  });

  it('throws on a files[] entry with a non-numeric size', () => {
    const malformed = `version: 1.0.0
files:
  - url: rig-1.0.0.zip
    sha512: abc
    size: not-a-number
`;
    expect(() => parseUpdateManifest(malformed)).toThrow(/Malformed/);
  });

  it('ignores blank lines and comment lines', () => {
    const withNoise = `# a comment
version: 1.0.0

files:
  # another comment
  - url: rig-1.0.0.zip
    sha512: abc
    size: 100

`;
    const result = parseUpdateManifest(withNoise);
    expect(result.version).toBe('1.0.0');
    expect(result.files).toHaveLength(1);
  });
});

describe('isManifestVersionAtLeast', () => {
  it('equal versions are "at least"', () => {
    expect(isManifestVersionAtLeast('0.3.2', '0.3.2')).toBe(true);
  });

  it('a newer manifest version passes', () => {
    expect(isManifestVersionAtLeast('0.3.3', '0.3.2')).toBe(true);
  });

  it('an OLDER manifest version fails — the stale-CDN-cache case this check exists to catch', () => {
    expect(isManifestVersionAtLeast('0.3.1', '0.3.2')).toBe(false);
  });

  it('a canary version genuinely ahead of the stable base passes (real precedence, not a naive string compare)', () => {
    expect(isManifestVersionAtLeast('0.3.3-canary.4', '0.3.2')).toBe(true);
  });

  it('a canary prerelease of the SAME base as minVersion is lower precedence — correctly fails', () => {
    // Real semver: 0.3.2-canary.1 < 0.3.2.
    expect(isManifestVersionAtLeast('0.3.2-canary.1', '0.3.2')).toBe(false);
  });

  it('an unparseable version on either side degrades to false, never a false pass', () => {
    expect(isManifestVersionAtLeast('not-a-version', '0.3.2')).toBe(false);
    expect(isManifestVersionAtLeast('0.3.2', 'not-a-version')).toBe(false);
  });
});

describe('compareManifests', () => {
  const local: UpdateManifest = {
    version: '0.3.2',
    files: [
      { url: 'rig-0.3.2-arm64.zip', sha512: 'zip-hash', size: 100 },
      { url: 'rig-0.3.2-arm64.dmg', sha512: 'dmg-hash', size: 200 },
    ],
    path: 'rig-0.3.2-arm64.zip',
    sha512: 'zip-hash',
    releaseDate: '2026-08-18T00:00:00.000Z',
  };

  it('identical remote/local manifests — ok', () => {
    const remote: UpdateManifest = { ...local, files: [...local.files] };
    expect(compareManifests(remote, local)).toEqual({ ok: true });
  });

  it('a version mismatch is reported', () => {
    const remote: UpdateManifest = { ...local, version: '0.3.1' };
    const result = compareManifests(remote, local);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.mismatches.some((m) => m.startsWith('version:'))).toBe(true);
  });

  it('a sha512 mismatch on a matched file is reported — the actual "CDN serves stale bytes" case', () => {
    const remote: UpdateManifest = {
      ...local,
      files: [{ ...local.files[0]!, sha512: 'DIFFERENT-hash' }, local.files[1]!],
    };
    const result = compareManifests(remote, local);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.mismatches.some((m) => m.includes('sha512 mismatch'))).toBe(true);
  });

  it('a size mismatch on a matched file is reported', () => {
    const remote: UpdateManifest = {
      ...local,
      files: [{ ...local.files[0]!, size: 999 }, local.files[1]!],
    };
    const result = compareManifests(remote, local);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.mismatches.some((m) => m.includes('size mismatch'))).toBe(true);
  });

  it('a file present remotely but missing locally is reported', () => {
    const remote: UpdateManifest = {
      ...local,
      files: [...local.files, { url: 'rig-0.3.2-arm64.AppImage', sha512: 'x', size: 1 }],
    };
    const result = compareManifests(remote, local);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.mismatches.some((m) => m.includes('AppImage') && m.includes('not in the local build'))).toBe(
      true
    );
  });

  it('a file present locally but missing remotely is reported', () => {
    const remote: UpdateManifest = { ...local, files: [local.files[0]!] };
    const result = compareManifests(remote, local);
    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.mismatches.some((m) => m.includes('rig-0.3.2-arm64.dmg') && m.includes('missing from the CDN'))
    ).toBe(true);
  });

  it('matches files by url, not array position', () => {
    const remote: UpdateManifest = { ...local, files: [local.files[1]!, local.files[0]!] };
    expect(compareManifests(remote, local)).toEqual({ ok: true });
  });
});

describe('sizeMatches', () => {
  it('equal sizes match', () => {
    expect(sizeMatches(1024, 1024)).toBe(true);
  });

  it('different sizes do not match', () => {
    expect(sizeMatches(1024, 2048)).toBe(false);
  });

  it('a null content-length (header absent) is honestly "unknown", never a match', () => {
    expect(sizeMatches(1024, null)).toBe(false);
  });
});
