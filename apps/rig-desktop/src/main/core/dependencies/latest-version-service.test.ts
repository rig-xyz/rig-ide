import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LatestVersionService, type PersistedLatestVersion } from './latest-version-service';

const fetchMock = vi.fn<typeof fetch>();

function mockFetch(responseBody: string, status = 200) {
  // Fresh Response per call: a body can only be consumed once.
  fetchMock.mockImplementation(async () => new Response(responseBody, { status }));
}

function mockFetchError(errorMsg: string) {
  fetchMock.mockRejectedValue(new Error(errorMsg));
}

describe('LatestVersionService', () => {
  let service: LatestVersionService;

  beforeEach(() => {
    service = new LatestVersionService();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for releaseSource kind=none', async () => {
    const version = await service.fetchLatestVersion({ kind: 'none' });
    expect(version).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches version from npm registry', async () => {
    mockFetch(JSON.stringify({ version: '2.3.4' }));

    const version = await service.fetchLatestVersion({ kind: 'npm', package: '@openai/codex' });

    expect(version).toBe('2.3.4');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('registry.npmjs.org'),
      expect.anything()
    );
  });

  it('fetches version from github releases, stripping v prefix', async () => {
    mockFetch(JSON.stringify({ tag_name: 'v1.5.0' }));

    const version = await service.fetchLatestVersion({
      kind: 'github',
      repo: 'anthropics/claude-code',
    });

    expect(version).toBe('1.5.0');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.github.com'),
      expect.anything()
    );
  });

  it('returns null and does not throw on network error', async () => {
    mockFetchError('ENOTFOUND');

    const version = await service.fetchLatestVersion({ kind: 'npm', package: 'codebuff' });

    expect(version).toBeNull();
  });

  it('returns null on HTTP error status', async () => {
    mockFetch('Not Found', 404);

    const version = await service.fetchLatestVersion({ kind: 'npm', package: 'nonexistent-pkg' });

    expect(version).toBeNull();
  });

  it('caches results and does not re-fetch within TTL', async () => {
    mockFetch(JSON.stringify({ version: '1.0.0' }));

    await service.fetchLatestVersion({ kind: 'npm', package: '@openai/codex' });
    await service.fetchLatestVersion({ kind: 'npm', package: '@openai/codex' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache entry and re-fetches', async () => {
    mockFetch(JSON.stringify({ version: '1.0.0' }));

    await service.fetchLatestVersion({ kind: 'npm', package: '@openai/codex' });
    service.invalidate({ kind: 'npm', package: '@openai/codex' });
    await service.fetchLatestVersion({ kind: 'npm', package: '@openai/codex' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('with a store', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const CODEX = { kind: 'npm', package: '@openai/codex' } as const;

    function memoryStore(initial: Record<string, PersistedLatestVersion> = {}) {
      const entries = { ...initial };
      return {
        entries,
        get: vi.fn(async (key: string) => entries[key] ?? null),
        set: vi.fn(async (key: string, value: PersistedLatestVersion) => {
          entries[key] = value;
        }),
      };
    }

    it('uses a version fetched less than a day ago without asking the registry', async () => {
      const store = memoryStore({ 'npm:@openai/codex': { version: '0.160.1', fetchedAt: Date.now() - DAY / 2 } });
      const version = await new LatestVersionService({ store }).fetchLatestVersion(CODEX);
      expect(version).toBe('0.160.1');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('asks again once the stored version is a day old, and stores the answer', async () => {
      const store = memoryStore({ 'npm:@openai/codex': { version: '0.150.0', fetchedAt: Date.now() - DAY - 1 } });
      mockFetch(JSON.stringify({ version: '0.160.1' }));
      const version = await new LatestVersionService({ store }).fetchLatestVersion(CODEX);
      expect(version).toBe('0.160.1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.entries['npm:@openai/codex']?.version).toBe('0.160.1');
    });

    it('falls back to the stored version quietly when offline', async () => {
      const store = memoryStore({ 'npm:@openai/codex': { version: '0.150.0', fetchedAt: Date.now() - 2 * DAY } });
      mockFetchError('ENOTFOUND');
      const version = await new LatestVersionService({ store }).fetchLatestVersion(CODEX);
      expect(version).toBe('0.150.0');
    });

    it('goes to the registry after invalidate even when the store is fresh', async () => {
      const store = memoryStore({ 'npm:@openai/codex': { version: '0.150.0', fetchedAt: Date.now() } });
      mockFetch(JSON.stringify({ version: '0.160.1' }));
      const service = new LatestVersionService({ store });
      service.invalidate(CODEX);
      expect(await service.fetchLatestVersion(CODEX)).toBe('0.160.1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
