import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `getMyAgents` (GET /v1/me/agents) and `otherMacsAgents`: what your other Macs can run. */

const resolveContext = vi.fn();
vi.mock('../account', () => ({
  resolveContext: (...args: unknown[]) => resolveContext(...args),
  isError: (v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SpacesRelayApi getMyAgents', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    resolveContext.mockResolvedValue({ url: 'https://relay.test/', token: 'pat' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function api() {
    const { createHttpSpacesRelayApi } = await import('./relay-api');
    return createHttpSpacesRelayApi();
  }

  it("reads each computer's agents, dropping anything that isn't Claude or Codex", async () => {
    fetchMock.mockResolvedValue(
      json({
        agents: ['claude', 'codex'],
        devices: [
          { device: 'mac-a', agents: ['codex', 'gemini'], updatedAt: '2026-10-07T10:00:00Z' },
          { device: 'mac-b', agents: ['claude'], updatedAt: '2026-10-06T10:00:00Z' },
          { agents: ['claude'] },
        ],
      })
    );
    const result = await (await api()).getMyAgents!();
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/v1/me/agents');
    expect(result).toEqual({
      success: true,
      data: { devices: [{ device: 'mac-a', agents: ['codex'] }, { device: 'mac-b', agents: ['claude'] }] },
    });
  });

  it('is null from a relay without the route, and an error when the relay fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'not_found' }, 404));
    expect(await (await api()).getMyAgents!()).toEqual({ success: true, data: null });
    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 500));
    expect((await (await api()).getMyAgents!()).success).toBe(false);
  });
});

describe('otherMacsAgents', () => {
  it("is every computer's agents but this one's", async () => {
    const { otherMacsAgents } = await import('./relay-api');
    const report = {
      devices: [
        { device: 'this-mac', agents: ['codex' as const] },
        { device: 'other-mac', agents: ['claude' as const] },
      ],
    };
    expect(otherMacsAgents(report, 'this-mac')).toEqual(['claude']);
    expect(otherMacsAgents(report, 'other-mac')).toEqual(['codex']);
    expect(otherMacsAgents({ devices: [{ device: 'this-mac', agents: ['claude'] }] }, 'this-mac')).toEqual([]);
  });
});
