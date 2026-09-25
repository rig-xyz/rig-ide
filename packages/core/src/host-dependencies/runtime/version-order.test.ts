import { describe, expect, it } from 'vitest';
import { compareVersionStrings } from './version-order';

describe('compareVersionStrings', () => {
  it('is positive when a is a higher patch version', () => {
    expect(compareVersionStrings('0.147.1', '0.147.0')).toBeGreaterThan(0);
  });

  it('is negative when a is a lower minor version', () => {
    expect(compareVersionStrings('0.140.0', '0.147.0')).toBeLessThan(0);
  });

  it('is zero for equal versions', () => {
    expect(compareVersionStrings('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats a missing trailing segment as 0', () => {
    expect(compareVersionStrings('1.2', '1.2.0')).toBe(0);
    expect(compareVersionStrings('1.3', '1.2.9')).toBeGreaterThan(0);
  });

  // The codex case this exists for: a prerelease-tagged version whose numeric
  // triplet is higher must still beat a plain lower release. Real semver
  // precedence would get this backwards (a prerelease of X.Y.Z sorts below
  // the plain X.Y.Z release) — but `extractVersion` already strips the
  // `-alpha.9.2` suffix before this function ever sees the string, so the
  // comparison never has to reason about prerelease precedence at all.
  it('ranks a higher numeric triplet above a lower one regardless of a stripped prerelease suffix', () => {
    expect(compareVersionStrings('0.155.0', '0.147.0')).toBeGreaterThan(0);
  });

  it('is zero (tie, caller falls back to candidate order) when either version is unparseable', () => {
    expect(compareVersionStrings('not-a-version', '1.0.0')).toBe(0);
    expect(compareVersionStrings('1.0.0', 'not-a-version')).toBe(0);
    expect(compareVersionStrings('1.x.0', '1.0.0')).toBe(0);
  });

  it('is zero (tie) when either version is null', () => {
    expect(compareVersionStrings(null, '1.0.0')).toBe(0);
    expect(compareVersionStrings('1.0.0', null)).toBe(0);
    expect(compareVersionStrings(null, null)).toBe(0);
  });
});
