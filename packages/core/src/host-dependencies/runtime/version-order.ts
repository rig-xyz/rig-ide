/**
 * Best-effort dotted-numeric version comparison for `preferNewest` auto-resolution.
 *
 * Deliberately not full semver: a version like codex's `0.155.0-alpha.9.2` must
 * compare as *newer* than `0.147.0`, which real semver precedence rules would get
 * backwards (a prerelease of X.Y.Z always sorts below the plain X.Y.Z release).
 * `extractVersion` already strips any `-prerelease` suffix before this ever sees
 * the string, so comparison only has to walk the leading dotted-numeric run.
 */

/** Splits "0.155.0" into [0, 155, 0]. Returns null if any segment isn't a plain integer. */
function parseVersionParts(version: string): number[] | null {
  const segments = version.split('.');
  const parts = segments.map((segment) => Number.parseInt(segment, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/**
 * Compares two version strings numerically, segment by segment, treating a
 * missing trailing segment as 0 (so "1.2" === "1.2.0"). Returns positive when
 * `a` is newer, negative when `b` is newer, 0 on a tie or when either version
 * is null/unparseable (callers should fall back to candidate order on 0).
 */
export function compareVersionStrings(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  if (!partsA || !partsB) return 0;

  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
