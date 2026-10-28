import { beforeEach, describe, expect, it, vi } from 'vitest';

/** With Rig Alpha off, the Feed and the orchestrator never reach the relay: no `/v1/me/feed` or `/v1/me/orch` call goes out. */

const settings = vi.hoisted(() => ({ alphaEnabled: false }));
const fetchRelay = vi.hoisted(() => vi.fn());
vi.mock('../settings-instance', () => ({ rigSettingsStore: { get: () => settings } }));
vi.mock('../relay-request', () => ({ fetchRelay }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('../account', () => ({
  resolveContext: async () => ({ url: 'https://relay.test', token: 't' }),
  isError: () => false,
}));

import { getFeed, orchAgentState, orchQuery } from './relay';

beforeEach(() => {
  fetchRelay.mockReset();
  fetchRelay.mockResolvedValue(new Response(JSON.stringify({ visible: [], queued: [] }), { status: 200 }));
});

describe('the Feed relay with Rig Alpha off', () => {
  it('calls nothing, and says why', async () => {
    settings.alphaEnabled = false;
    const results = await Promise.all([getFeed(), orchAgentState(), orchQuery('feed', {})]);
    expect(fetchRelay).not.toHaveBeenCalled();
    for (const r of results) expect(r.success ? null : r.error.kind).toBe('alphaOff');
  });

  it('calls the relay with it on', async () => {
    settings.alphaEnabled = true;
    await getFeed();
    expect(fetchRelay).toHaveBeenCalledTimes(1);
    expect(String(fetchRelay.mock.calls[0]![0])).toBe('https://relay.test/v1/me/feed');
  });
});
