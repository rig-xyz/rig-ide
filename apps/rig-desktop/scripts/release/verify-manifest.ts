/**
 * Smoke-checks that a PUBLISHED update is actually consumable — i.e. that
 * an installed app pointed at `${R2_BASE_URL}/${channel}...yml` would
 * genuinely be able to update, not just that the upload step exited 0.
 *
 * For each platform's manifest on the given channel, this:
 *   1. GETs the manifest from the CDN (bounded timeout) and parses it
 *   2. HEADs every file it references (plus each file's `.blockmap`
 *      sibling, when the manifest declares a `blockMapSize`), asserting
 *      200 + a content-length matching the manifest's declared size
 *   3. when a same-named manifest exists locally in `release/` (i.e. this
 *      is run right after a build, not standalone), compares the remote
 *      manifest against it exactly — version, and per-file sha512/size —
 *      the real integrity check that the CDN is serving what was just
 *      built, not something stale or partially uploaded. Skipped, with a
 *      clear message, when there's no local manifest to compare against.
 *   4. asserts the manifest's version is >= this package's version,
 *      surfacing loudly the exact failure mode that has bitten this
 *      project before by hand: a stale edge/CDN cache serving an OLDER
 *      manifest than the one that was just uploaded.
 *
 * Exits non-zero via `fail()` with a precise message on the first problem
 * found; prints a short summary on success.
 *
 * Usage:
 *   node --experimental-strip-types scripts/release/verify-manifest.ts [--channel v1-stable] [--platform mac|linux|win|all]
 *
 * --channel defaults to this build's UPDATE_CHANNEL; --platform defaults
 * to "all" (every platform this app ships for). Run with an explicit
 * --platform right after that platform's own build + R2 upload to get the
 * real local-vs-remote integrity check (see release-prod.yml); run with
 * the default "all" as a final gate (e.g. in finalize-release) to confirm
 * every platform's manifest is independently fetchable and current.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { findManifests } from './lib/artifacts.ts';
import { RELEASE_DIR, R2_BASE_URL, UPDATE_CHANNEL } from './lib/config.ts';
import { fail, info, step, warn } from './lib/log.ts';
import { compareManifests, isManifestVersionAtLeast, parseUpdateManifest, sizeMatches } from './lib/manifest.ts';

const FETCH_TIMEOUT_MS = 15_000;

/**
 * electron-updater's per-platform manifest filename suffix, traced from
 * `Provider.getChannelFilePrefix()` in
 * node_modules/electron-updater/out/providers/Provider.js: darwin gets
 * `-mac`; linux gets `-linux` (+ `-${arch}` for a non-x64 arch — not
 * needed here since this app's release workflow only builds linux/x64);
 * Windows gets no suffix at all ("for historical reasons", per that
 * file's own comment).
 */
const PLATFORM_SUFFIXES = { mac: '-mac', linux: '-linux', win: '' } as const;
type PlatformKey = keyof typeof PLATFORM_SUFFIXES;

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    platform: { type: 'string' },
  },
  strict: true,
});

const channel = values.channel ?? UPDATE_CHANNEL;
const platformArg = values.platform ?? 'all';
if (platformArg !== 'all' && !(platformArg in PLATFORM_SUFFIXES)) {
  fail(`Unknown --platform "${platformArg}" (expected mac, linux, win, or all)`);
}
const platforms: PlatformKey[] =
  platformArg === 'all' ? (Object.keys(PLATFORM_SUFFIXES) as PlatformKey[]) : [platformArg as PlatformKey];

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string };

let anyManifestFound = false;

for (const platform of platforms) {
  const filename = `${channel}${PLATFORM_SUFFIXES[platform]}.yml`;
  step(`Verifying ${filename}`);

  const manifestUrl = `${R2_BASE_URL}/${filename}`;
  const remoteText = await fetchManifestText(manifestUrl);
  if (remoteText === null) {
    warn(`No manifest at ${manifestUrl} — skipping (this platform may not have shipped on channel "${channel}")`);
    continue;
  }
  anyManifestFound = true;

  const remote = parseUpdateManifest(remoteText);
  info(`Remote version: ${remote.version}`);

  if (!isManifestVersionAtLeast(remote.version, pkg.version)) {
    fail(
      `${filename}: the CDN is serving version ${remote.version}, older than this package's version ${pkg.version} — this looks like a stale cache`
    );
  }

  for (const file of remote.files) {
    await verifyFileHead(manifestUrl, file.url, file.size);
    if (file.blockMapSize !== undefined) {
      await verifyFileHead(manifestUrl, `${file.url}.blockmap`, file.blockMapSize);
    }
  }
  info(`All ${remote.files.length} file(s) on the manifest are reachable with matching content-length`);

  const localManifestPath = findManifests(channel, RELEASE_DIR).find((p) => basename(p) === filename);
  if (!localManifestPath) {
    info(`No local ${filename} in ${RELEASE_DIR}/ — skipping local sha512 comparison (not running right after a build)`);
    continue;
  }
  const local = parseUpdateManifest(readFileSync(localManifestPath, 'utf-8'));
  const comparison = compareManifests(remote, local);
  if (!comparison.ok) {
    fail(`${filename}: the published manifest doesn't match the local build:\n  ${comparison.mismatches.join('\n  ')}`);
  }
  info('Remote manifest matches the local build exactly (version + per-file sha512/size)');
}

if (!anyManifestFound) {
  fail(`No manifest found on the CDN for channel "${channel}" on any of: ${platforms.join(', ')}`);
}

info(`Manifest verification passed for channel "${channel}" (${platforms.join(', ')})`);

async function fetchManifestText(url: string): Promise<string | null> {
  const response = await safeFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) fail(`GET ${url} returned ${response.status}`);
  return response.text();
}

async function verifyFileHead(manifestUrl: string, relativeFilename: string, expectedSize: number): Promise<void> {
  const url = new URL(relativeFilename, manifestUrl).toString();
  const response = await safeFetch(url, { method: 'HEAD' });
  if (!response.ok) {
    fail(`${relativeFilename}: HEAD ${url} returned ${response.status} — referenced by the manifest but not actually fetchable`);
  }
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (!sizeMatches(expectedSize, contentLength)) {
    fail(
      `${relativeFilename}: content-length ${contentLengthHeader ?? '(missing)'} does not match the manifest's declared size ${expectedSize}`
    );
  }
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    fail(`Failed to reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
