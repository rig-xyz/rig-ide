import type { ReleaseSource } from '@emdash/core/deps';
import type { Logger } from '@emdash/core/lib';

const REQUEST_TIMEOUT_MS = 10_000;
/** Ask the registry at most once a day per package, across restarts when a store is given. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  version: string | null;
  expiresAt: number;
}

/** The last version a registry returned for one source, and when. */
export type PersistedLatestVersion = { version: string; fetchedAt: number };

/** Where fetched versions outlive the process, so a restart doesn't ask the registry again. */
export interface LatestVersionStore {
  get(key: string): Promise<PersistedLatestVersion | null>;
  set(key: string, value: PersistedLatestVersion): Promise<void>;
}

function cacheKeyFor(source: Exclude<ReleaseSource, { kind: 'none' }>): string {
  return source.kind === 'npm' ? `npm:${source.package}` : `github:${source.repo}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'emdash-latest-version',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export class LatestVersionService {
  private cache = new Map<string, CacheEntry>();
  /** Keys `invalidate` was called for: the next fetch goes to the network even if the store is fresh. */
  private forceFetch = new Set<string>();
  private logger?: Logger;
  private store?: LatestVersionStore;

  constructor(options?: { logger?: Logger; store?: LatestVersionStore }) {
    this.logger = options?.logger;
    this.store = options?.store;
  }

  /**
   * Fetch the latest published version for the given release source.
   * Returns null when the source is 'none', the network is unavailable, or any
   * error occurs — callers should treat null as "unknown" and hide update UI.
   * Offline, a previously stored version (even a stale one) is returned instead.
   */
  async fetchLatestVersion(source: ReleaseSource): Promise<string | null> {
    if (source.kind === 'none') return null;

    const cacheKey = cacheKeyFor(source);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.version;

    const stored = await this.readStored(cacheKey);
    const forced = this.forceFetch.delete(cacheKey);
    if (stored && !forced && Date.now() - stored.fetchedAt < CACHE_TTL_MS) {
      this.cache.set(cacheKey, { version: stored.version, expiresAt: stored.fetchedAt + CACHE_TTL_MS });
      return stored.version;
    }

    try {
      const version = await this.resolve(source);
      const fetchedAt = Date.now();
      this.cache.set(cacheKey, { version, expiresAt: fetchedAt + CACHE_TTL_MS });
      if (version) await this.writeStored(cacheKey, { version, fetchedAt });
      return version;
    } catch (err) {
      this.logger?.debug(`[latest-version] failed to fetch ${cacheKey}: ${(err as Error).message}`);
      return stored?.version ?? null;
    }
  }

  private async readStored(key: string): Promise<PersistedLatestVersion | null> {
    try {
      return (await this.store?.get(key)) ?? null;
    } catch {
      return null;
    }
  }

  private async writeStored(key: string, value: PersistedLatestVersion): Promise<void> {
    try {
      await this.store?.set(key, value);
    } catch {
      // A version we couldn't save is only asked for again on the next launch.
    }
  }

  private async resolve(source: ReleaseSource): Promise<string | null> {
    if (source.kind === 'npm') {
      const url = `https://registry.npmjs.org/${encodeURIComponent(source.package)}/latest`;
      const json = (await fetchJson(url)) as { version?: string };
      return json.version ?? null;
    }

    if (source.kind === 'github') {
      const url = `https://api.github.com/repos/${source.repo}/releases/latest`;
      const json = (await fetchJson(url)) as { tag_name?: string };
      const tag = json.tag_name ?? null;
      return tag ? tag.replace(/^v/, '') : null;
    }

    return null;
  }

  /** Evict a specific entry (e.g. after a successful update). */
  invalidate(source: ReleaseSource): void {
    if (source.kind === 'none') return;
    const cacheKey = cacheKeyFor(source);
    this.cache.delete(cacheKey);
    this.forceFetch.add(cacheKey);
  }
}
