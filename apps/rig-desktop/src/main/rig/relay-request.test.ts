import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.4.10' } }));

const {
  fetchRelay,
  recentRelayFailures,
  recentRelayRequestId,
  resetRelayFailuresForTests,
  rigClientHeaders,
  routeOf,
} = await import('./relay-request');

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetRelayFailuresForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRelay', () => {
  it('says which app is asking on every call, keeping the caller’s own headers', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await fetchRelay('https://tap-relay.fly.dev/v1/me', {
      headers: { authorization: 'Bearer x', accept: 'application/json' },
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer x',
      accept: 'application/json',
      'x-rig-version': '0.4.10',
      'x-rig-os': expect.stringContaining(process.platform),
    });
    expect(rigClientHeaders()['x-rig-version']).toBe('0.4.10');
  });

  it('works with a Headers object and with no init at all', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await fetchRelay(new URL('https://tap-relay.fly.dev/v1/me'), {
      headers: new Headers({ accept: 'application/json' }),
    });
    await fetchRelay('https://tap-relay.fly.dev/v1/me');
    const first = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((first.headers as Headers).get('x-rig-version')).toBe('0.4.10');
    expect((first.headers as Headers).get('accept')).toBe('application/json');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      'x-rig-version': '0.4.10',
    });
  });

  it('remembers the relay request id of a failed call, and nothing of the path that could identify anyone', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', { status: 500, headers: { 'x-request-id': 'req_9' } })
    );
    const response = await fetchRelay(
      'https://tap-relay.fly.dev/v1/invites/tap_inv_AbCdEfGhIjKlMnOp/accept',
      {
        method: 'post',
      }
    );
    expect(response.status).toBe(500);
    expect(recentRelayFailures()).toEqual([
      {
        reqId: 'req_9',
        status: 500,
        method: 'POST',
        route: '/v1/invites/:id/accept',
        at: expect.any(Number),
      },
    ]);
    expect(recentRelayRequestId()).toBe('req_9');
    // Too old to belong to an error happening now.
    expect(recentRelayRequestId(Date.now() + 3 * 60_000)).toBeUndefined();
  });

  it('a call that never got an answer is remembered without an id, and still throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(fetchRelay('https://tap-relay.fly.dev/v1/me/spaces/status')).rejects.toThrow(
      'fetch failed'
    );
    expect(recentRelayFailures()).toEqual([
      {
        reqId: null,
        status: null,
        method: 'GET',
        route: '/v1/me/spaces/status',
        at: expect.any(Number),
      },
    ]);
    expect(recentRelayRequestId()).toBeUndefined();
  });

  it('a successful call is not remembered', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 201, headers: { 'x-request-id': 'req_ok' } })
    );
    await fetchRelay('https://tap-relay.fly.dev/v1/me/problem-reports', { method: 'POST' });
    expect(recentRelayFailures()).toEqual([]);
  });
});

describe('routeOf', () => {
  it('keeps plain words and versions, replaces ids, secrets and names with :id', () => {
    expect(routeOf('https://r.dev/v1/me/bindings/bnd_12ab/manifest?after=chg_5')).toBe(
      '/v1/me/bindings/:id/manifest'
    );
    expect(routeOf('https://r.dev/v1/me/home-layout')).toBe('/v1/me/home-layout');
    expect(routeOf('https://r.dev/v1/spaces/My%20Space/messages')).toBe('/v1/spaces/:id/messages');
  });
});
