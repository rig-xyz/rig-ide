import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The signed-in user's id is remembered per token (`resolveSelfUserId`), so
 * opening a rig or space asks `GET /v1/me` once at most — and never serves
 * a stale id after sign-in, sign-out or an account switch.
 */

const readRelayToken = vi.fn<() => Promise<string | null>>();
vi.mock('./config', () => ({ readRelayToken: () => readRelayToken() }));

function meResponse(id: string): Response {
  return new Response(JSON.stringify({ user: { id, clerkUserId: `clerk_${id}` } }), { status: 200 });
}

describe('resolveSelfUserId', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('RIG_RELAY_URL', '');
    fetchMock = vi.fn(async () => meResponse('u1'));
    vi.stubGlobal('fetch', fetchMock);
    readRelayToken.mockResolvedValue('token-a');
    (await import('./account')).forgetSelfUserId();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks the relay once per token, for every caller on the open path', async () => {
    const { resolveSelfUserId, getCurrentAccountId } = await import('./account');
    expect(await resolveSelfUserId()).toEqual({ success: true, data: 'u1' });
    expect(await getCurrentAccountId()).toEqual({ status: 'known', id: 'u1' });
    expect(await resolveSelfUserId()).toEqual({ success: true, data: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const { resolveSelfUserId, getCurrentAccountId } = await import('./account');
    const [a, b] = await Promise.all([resolveSelfUserId(), getCurrentAccountId()]);
    expect(a).toEqual({ success: true, data: 'u1' });
    expect(b).toEqual({ status: 'known', id: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again for another token (another account signed in)', async () => {
    const { resolveSelfUserId } = await import('./account');
    await resolveSelfUserId();
    readRelayToken.mockResolvedValue('token-b');
    fetchMock.mockImplementation(async () => meResponse('u2'));
    expect(await resolveSelfUserId()).toEqual({ success: true, data: 'u2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forgets on sign-in/out (forgetSelfUserId)', async () => {
    const { resolveSelfUserId, forgetSelfUserId } = await import('./account');
    await resolveSelfUserId();
    forgetSelfUserId();
    await resolveSelfUserId();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads as signed out with no token, without asking the relay', async () => {
    const { getCurrentAccountId, resolveSelfUserId } = await import('./account');
    await resolveSelfUserId();
    readRelayToken.mockResolvedValue(null);
    expect(await getCurrentAccountId()).toEqual({ status: 'signedOut' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure: a relay hiccup is asked again', async () => {
    const { getCurrentAccountId } = await import('./account');
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    expect(await getCurrentAccountId()).toEqual({ status: 'unknown' });
    expect(await getCurrentAccountId()).toEqual({ status: 'known', id: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a dead token is an error, not an id', async () => {
    const { resolveSelfUserId } = await import('./account');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 }));
    const result = await resolveSelfUserId();
    expect(result.success).toBe(false);
    expect(!result.success && result.error.kind).toBe('invalidToken');
  });

  it('me() fills it in, so the first open after launch asks nothing more', async () => {
    const { rigAccountController, resolveSelfUserId } = await import('./account');
    await rigAccountController.me();
    expect(await resolveSelfUserId()).toEqual({ success: true, data: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
