import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `requestAccountDeletion`: the relay call behind Settings › Account › Delete account. */

const readRelayToken = vi.fn<() => Promise<string | null>>();
vi.mock('./config', () => ({ readRelayToken: () => readRelayToken() }));

describe('requestAccountDeletion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('RIG_RELAY_URL', '');
    readRelayToken.mockResolvedValue('rpat_token');
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            deletionScheduledAt: '2026-10-11T12:00:00.000Z',
            alreadyScheduled: false,
          }),
          {
            status: 200,
          }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts the confirmation with the token and returns the date', async () => {
    const { requestAccountDeletion } = await import('./account');
    expect(await requestAccountDeletion()).toEqual({
      success: true,
      data: { deletionScheduledAt: '2026-10-11T12:00:00.000Z', alreadyScheduled: false },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tap-relay.fly.dev/v1/me/delete');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer rpat_token');
    expect(JSON.parse(init.body as string)).toEqual({ confirm: 'delete' });
  });

  it('a revoked token reads as signed out, not a generic failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })
    );
    const { requestAccountDeletion } = await import('./account');
    const result = await requestAccountDeletion();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.kind).toBe('invalidToken');
  });

  it("doesn't ask the relay without a token", async () => {
    readRelayToken.mockResolvedValue(null);
    const { requestAccountDeletion } = await import('./account');
    const result = await requestAccountDeletion();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.kind).toBe('notSignedIn');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads deletionScheduledAt off GET /v1/me when the relay sends it', async () => {
    const { toUser } = await import('./account');
    expect(
      toUser({ id: 'u', clerkUserId: 'c', deletionScheduledAt: '2026-10-11T12:00:00.000Z' })
        ?.deletionScheduledAt
    ).toBe('2026-10-11T12:00:00.000Z');
    expect(toUser({ id: 'u', clerkUserId: 'c' })).not.toHaveProperty('deletionScheduledAt');
  });
});
