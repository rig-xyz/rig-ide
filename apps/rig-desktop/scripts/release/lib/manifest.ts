/**
 * Pure parsing/comparison for electron-builder's own generated update
 * manifest (`<channel>-mac.yml`, etc. — `verify-manifest.ts` is the
 * effectful script that fetches one and calls into this). No I/O here on
 * purpose, so it's testable against fixtures without a network.
 *
 * Dependency check done before writing this (per the round's own brief —
 * "check what deps exist before adding one"):
 *   - `js-yaml`/`yaml` are NOT used anywhere in this app's own `src/` or
 *     `scripts/` — only present as hoisted transitive deps of something
 *     else in the monorepo, not a real dependency of this package. The
 *     manifest itself is a small, well-known FLAT shape (top-level scalars
 *     + one `files:` list of maps) — a hand-parse tailored to exactly that
 *     shape, not a general YAML parser, is the dependency-free option the
 *     brief itself called acceptable. Verified against a REAL generated
 *     manifest (`release/v1-stable-mac.yml`, present from a local build —
 *     see this file's own test fixtures), not guessed at.
 *   - `semver` IS already relied on elsewhere in this exact codebase
 *     (`src/main/core/dependencies/agent-update-service.ts`, `import
 *     semver from 'semver'`) despite not being a declared dependency in
 *     `package.json` either — it resolves via the monorepo's workspace
 *     tree (declared by `packages/core`). Reused here rather than
 *     hand-rolling a second version comparator.
 */

import semver from 'semver';

export type UpdateManifestFile = {
  url: string;
  sha512: string;
  size: number;
  blockMapSize?: number;
};

export type UpdateManifest = {
  version: string;
  files: UpdateManifestFile[];
  path: string;
  sha512: string;
  releaseDate: string;
};

/**
 * Hand-parse for electron-builder's OWN generated shape only:
 *
 * ```yaml
 * version: 0.3.2
 * files:
 *   - url: rig-0.3.2-arm64.zip
 *     sha512: <base64>
 *     size: 215234129
 *   - url: rig-0.3.2-arm64.dmg
 *     sha512: <base64>
 *     size: 215185485
 * path: rig-0.3.2-arm64.zip
 * sha512: <base64>
 * releaseDate: '2026-08-18T00:04:28.621Z'
 * ```
 *
 * Top-level `key: value` scalars, plus ONE `files:` block of `- key: value`
 * list items with indented continuation lines. Throws on a structurally
 * unusable manifest (no `version`, or a `files[]` entry missing `url`/
 * `sha512`/a numeric `size`) rather than returning a half-populated object
 * a caller might trust by accident.
 */
export function parseUpdateManifest(text: string): UpdateManifest {
  const top: Record<string, string> = {};
  const files: UpdateManifestFile[] = [];
  let inFiles = false;
  let current: Record<string, string> | null = null;

  const flushCurrent = () => {
    if (!current) return;
    files.push(toManifestFile(current));
    current = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      // A top-level (unindented) key — ends any files: block in progress.
      flushCurrent();
      inFiles = false;
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (key === 'files') {
        inFiles = true;
        continue;
      }
      top[key] = unquote(rawValue);
      continue;
    }

    if (!inFiles) continue;

    const itemStart = /^\s*-\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (itemStart) {
      flushCurrent();
      current = { [itemStart[1]]: unquote(itemStart[2]) };
      continue;
    }
    const continuation = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (continuation && current) {
      current[continuation[1]] = unquote(continuation[2]);
    }
  }
  flushCurrent();

  if (!top.version) throw new Error('Manifest is missing a top-level "version" field');
  return {
    version: top.version,
    files,
    path: top.path ?? '',
    sha512: top.sha512 ?? '',
    releaseDate: top.releaseDate ?? '',
  };
}

function toManifestFile(entry: Record<string, string>): UpdateManifestFile {
  const size = Number(entry.size);
  if (!entry.url || !entry.sha512 || !Number.isFinite(size)) {
    throw new Error(`Malformed files[] entry in manifest: ${JSON.stringify(entry)}`);
  }
  const blockMapSize = entry.blockMapSize !== undefined ? Number(entry.blockMapSize) : undefined;
  return { url: entry.url, sha512: entry.sha512, size, ...(blockMapSize !== undefined ? { blockMapSize } : {}) };
}

function unquote(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  const last = value.at(-1);
  if (value.length >= 2 && ((first === "'" && last === "'") || (first === '"' && last === '"'))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * `manifestVersion >= minVersion`, real semver precedence (not a naive
 * string compare, and not lossy `semver.coerce` either — a coerced compare
 * would silently strip prerelease tags, e.g. treating `1.2.3-canary.1` as
 * plain `1.2.3`, and get exactly the canary-vs-stable case wrong). Either
 * side failing `semver.valid` degrades to `false` — never a pass on input
 * this can't actually parse as a real version.
 */
export function isManifestVersionAtLeast(manifestVersion: string, minVersion: string): boolean {
  if (!semver.valid(manifestVersion) || !semver.valid(minVersion)) return false;
  return semver.gte(manifestVersion, minVersion);
}

export type ManifestComparison = { ok: true } | { ok: false; mismatches: string[] };

/**
 * The real integrity check: does the manifest the CDN is CURRENTLY SERVING
 * (`remote`) describe what electron-builder ACTUALLY WROTE locally after
 * the build that's supposedly being published (`local`)? Matches `files[]`
 * entries by `url` (a basename, e.g. `rig-0.3.2-arm64.zip`), not array
 * position — neither side promises a stable order.
 */
export function compareManifests(remote: UpdateManifest, local: UpdateManifest): ManifestComparison {
  const mismatches: string[] = [];
  if (remote.version !== local.version) {
    mismatches.push(`version: remote="${remote.version}" local="${local.version}"`);
  }

  const localByUrl = new Map(local.files.map((f) => [f.url, f]));
  for (const remoteFile of remote.files) {
    const localFile = localByUrl.get(remoteFile.url);
    if (!localFile) {
      mismatches.push(`${remoteFile.url}: on the CDN but not in the local build`);
      continue;
    }
    if (remoteFile.sha512 !== localFile.sha512) {
      mismatches.push(`${remoteFile.url}: sha512 mismatch — the CDN is serving a different build than the one just made`);
    }
    if (remoteFile.size !== localFile.size) {
      mismatches.push(`${remoteFile.url}: size mismatch (remote=${remoteFile.size} local=${localFile.size})`);
    }
  }
  for (const localFile of local.files) {
    if (!remote.files.some((f) => f.url === localFile.url)) {
      mismatches.push(`${localFile.url}: in the local build but missing from the CDN manifest`);
    }
  }

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

/**
 * A HEAD response's `content-length` against the manifest's own declared
 * `size` for one file — pure comparison only, no fetch here. `null`
 * (header absent or unparseable) is honestly "unknown," never silently
 * treated as a match.
 */
export function sizeMatches(expectedSize: number, contentLength: number | null): boolean {
  return contentLength !== null && contentLength === expectedSize;
}
