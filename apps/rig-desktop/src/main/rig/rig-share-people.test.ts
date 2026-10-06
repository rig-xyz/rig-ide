import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Your people and member management against the relay, with `fetch`
 * mocked: `GET /v1/me/people` (cached, 404 means an older relay), person
 * invites by `targetUserId`, and the owner's role, remove and hand-over
 * calls.
 */

const mocks = vi.hoisted(() => ({
  readRelayToken: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@main/lib/telemetry', () => ({ telemetryService: { capture: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRelayToken: mocks.readRelayToken,
}));
const RELAY = 'http://127.0.0.1:8787'; // loopback: trusted by `checkRelayTrust`
vi.mock('./binding', () => ({
  findBindingConfig: () => ({ config: { bindingId: 'b_1', relayUrl: 'http://127.0.0.1:8787' } }),
}));

const { rigShareController, forgetPeopleCache, toPerson } = await import('./rig-share');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const JEREMIE = {
  userId: 'usr_j',
  clerkUserId: 'user_j',
  name: 'Jérémie Rappaz',
  imageUrl: null,
  sharedSpaces: [{ bindingId: 'b_2', name: 'feedback' }],
  lastSharedAt: '2026-10-06T09:00:00Z',
};

const INVITE = { id: 'inv_1', role: 'editor', useCount: 0, createdAt: '2026-10-06T10:00:00Z' };

describe('Your people and member management', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('RIG_RELAY_URL', RELAY);
    mocks.readRelayToken.mockReset().mockResolvedValue('rig_pat_token');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    forgetPeopleCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const call = (n: number) => {
    const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
    return {
      url,
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
  };

  it('reads Your people once, then from the cache until something changes it', async () => {
    fetchMock.mockResolvedValue(json(200, { people: [JEREMIE] }));
    const first = await rigShareController.people();
    expect(first).toEqual({
      success: true,
      data: { supported: true, people: [toPerson(JEREMIE)] },
    });
    await rigShareController.people();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ url: `${RELAY}/v1/me/people`, method: 'GET' });

    // Removing someone clears it.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await rigShareController.forgetPerson({ userId: 'usr_j' })).toEqual({
      success: true,
      data: { removed: true },
    });
    expect(call(1)).toMatchObject({ url: `${RELAY}/v1/me/people/usr_j`, method: 'DELETE' });
    await rigShareController.people();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('says unsupported on an older relay (404), so the renderer falls back', async () => {
    fetchMock.mockResolvedValue(new Response('404 Not Found', { status: 404 }));
    expect(await rigShareController.people()).toEqual({
      success: true,
      data: { supported: false, people: [] },
    });
  });

  it('aims an invite at a person by targetUserId, never an email', async () => {
    fetchMock.mockResolvedValueOnce(
      json(201, {
        invite: { ...INVITE, targetUserId: 'usr_j' },
        secret: 'tap_inv_x',
        email: { sent: false },
      })
    );
    const result = await rigShareController.createInvite({
      root: '/rigs/growth',
      email: null,
      targetUserId: 'usr_j',
      role: 'viewer',
    });
    expect(result.success).toBe(true);
    expect(call(0)).toEqual({
      url: `${RELAY}/v1/me/bindings/b_1/invites`,
      method: 'POST',
      body: { ops: ['read', 'write', 'subscribe'], role: 'viewer', targetUserId: 'usr_j' },
    });
  });

  it('revokes and fails when a relay ignored targetUserId and minted an open link', async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, { invite: INVITE, secret: 'tap_inv_x' }))
      .mockResolvedValueOnce(json(200, { revoked: true }));
    const result = await rigShareController.createInvite({
      root: '/rigs/growth',
      email: null,
      targetUserId: 'usr_j',
      role: 'editor',
    });
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Use their email') },
    });
    expect(call(1)).toMatchObject({
      url: `${RELAY}/v1/me/bindings/b_1/invites/inv_1`,
      method: 'DELETE',
    });
  });

  it('turns not_your_person into plain words', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'not_your_person' }));
    const result = await rigShareController.createInvite({
      root: '/rigs/growth',
      email: null,
      targetUserId: 'usr_x',
      role: 'editor',
    });
    expect(result).toMatchObject({
      success: false,
      error: { kind: 'forbidden', message: expect.stringContaining('by name') },
    });
  });

  it('person card invites by binding id on the account relay', async () => {
    fetchMock.mockResolvedValueOnce(
      json(201, { invite: { ...INVITE, targetUserId: 'usr_j' }, secret: 's' })
    );
    await rigShareController.inviteToSpace({
      bindingId: 'b_9',
      targetUserId: 'usr_j',
      role: 'editor',
    });
    expect(call(0)).toMatchObject({
      url: `${RELAY}/v1/me/bindings/b_9/invites`,
      method: 'POST',
      body: { targetUserId: 'usr_j', role: 'editor' },
    });
  });

  it('changes a role, removes a member and hands over ownership on the right routes', async () => {
    for (let i = 0; i < 3; i++) fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await rigShareController.setMemberRole({
      root: '/rigs/growth',
      userId: 'usr_h',
      role: 'viewer',
    });
    await rigShareController.removeMember({ root: '/rigs/growth', userId: 'usr_h' });
    await rigShareController.makeOwner({ root: '/rigs/growth', userId: 'usr_h' });
    expect([call(0), call(1), call(2)]).toEqual([
      {
        url: `${RELAY}/v1/me/bindings/b_1/members/usr_h`,
        method: 'PATCH',
        body: { role: 'viewer' },
      },
      { url: `${RELAY}/v1/me/bindings/b_1/members/usr_h`, method: 'DELETE', body: undefined },
      { url: `${RELAY}/v1/me/bindings/b_1/owner`, method: 'POST', body: { userId: 'usr_h' } },
    ]);
  });

  it('says plainly when an older relay has no hand-over route', async () => {
    fetchMock.mockResolvedValueOnce(new Response('404 Not Found', { status: 404 }));
    const result = await rigShareController.makeOwner({ root: '/rigs/growth', userId: 'usr_h' });
    expect(result).toMatchObject({
      success: false,
      error: { message: "This Rig server can't hand over ownership yet." },
    });
  });
});
