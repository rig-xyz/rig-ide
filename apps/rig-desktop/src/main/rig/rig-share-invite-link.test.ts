import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's "Join with a link" (`rigShareController.acceptInviteLink`): the
 * preview + secret-based accept against the account relay, with `fetch`
 * mocked. The sign-in token and the logger are mocked so nothing here
 * reads a real config file or writes a real log.
 */

const mocks = vi.hoisted(() => ({
  readRelayToken: vi.fn<() => Promise<string | null>>(),
  warn: vi.fn(),
}));

vi.mock('@main/lib/telemetry', () => ({ telemetryService: { capture: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRelayToken: mocks.readRelayToken,
}));

const { rigShareController } = await import('./rig-share');

const RELAY = 'http://127.0.0.1:8787'; // loopback: trusted by `checkRelayTrust`
const SECRET = 'tap_inv_s3cr3t';
const LINK = `https://userig.xyz/join/${SECRET}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACTIVE_PREVIEW = { status: 'active', binding: { name: 'growth' }, inviter: {}, invite: {} };

describe('acceptInviteLink', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('RIG_RELAY_URL', RELAY);
    mocks.readRelayToken.mockReset().mockResolvedValue('rig_pat_token');
    mocks.warn.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('previews for the name, accepts by secret with the account token, and returns the bindingId', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, ACTIVE_PREVIEW))
      .mockResolvedValueOnce(
        json(201, { bindingId: 'b_1', device: {}, token: {}, member: { role: 'editor' } })
      );

    const result = await rigShareController.acceptInviteLink({ link: LINK });

    expect(result).toEqual({
      success: true,
      data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true },
    });
    const [previewUrl, previewInit] = fetchMock.mock.calls[0]!;
    expect(previewUrl).toBe(`${RELAY}/v1/invites/${SECRET}`);
    expect(previewInit.method).toBe('GET');
    expect(previewInit.headers.authorization).toBeUndefined(); // public preview — no token sent
    const [acceptUrl, acceptInit] = fetchMock.mock.calls[1]!;
    expect(acceptUrl).toBe(`${RELAY}/v1/invites/${SECRET}/accept`);
    expect(acceptInit.method).toBe('POST');
    expect(acceptInit.headers.authorization).toBe('Bearer rig_pat_token');
  });

  it('treats "already a member" (201, member: null) as success', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, ACTIVE_PREVIEW))
      .mockResolvedValueOnce(json(201, { bindingId: 'b_1', device: {}, token: {}, member: null }));

    const result = await rigShareController.acceptInviteLink({ link: LINK });

    expect(result).toEqual({
      success: true,
      data: { bindingId: 'b_1', spaceName: 'growth', becameMember: false },
    });
  });

  it('rejects a non-invite link without touching the network', async () => {
    const result = await rigShareController.acceptInviteLink({
      link: 'https://evil.example/join/abc',
    });
    expect(result).toMatchObject({ success: false, error: { kind: 'invalidLink' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says notSignedIn with no token (the renderer then falls back to the browser)', async () => {
    mocks.readRelayToken.mockResolvedValue(null);
    const result = await rigShareController.acceptInviteLink({ link: LINK });
    expect(result).toMatchObject({ success: false, error: { kind: 'notSignedIn' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says notSignedIn when the relay rejects the token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, ACTIVE_PREVIEW))
      .mockResolvedValueOnce(json(401, { error: 'invalid_token' }));
    const result = await rigShareController.acceptInviteLink({ link: LINK });
    expect(result).toMatchObject({ success: false, error: { kind: 'notSignedIn', status: 401 } });
  });

  it('stops at the preview for a revoked or expired link', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...ACTIVE_PREVIEW, status: 'revoked' }));
    expect(await rigShareController.acceptInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'revoked' },
    });
    fetchMock.mockResolvedValueOnce(json(200, { ...ACTIVE_PREVIEW, status: 'expired' }));
    expect(await rigShareController.acceptInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'expired' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // never reached accept
  });

  it("maps the accept route's invite_invalid reasons to typed kinds", async () => {
    const cases: Array<[string, string]> = [
      ['exhausted', 'used'],
      ['expired', 'expired'],
      ['revoked', 'revoked'],
      ['email_mismatch', 'wrongAccount'],
      ['user_required', 'relay'],
    ];
    for (const [reason, kind] of cases) {
      fetchMock
        .mockResolvedValueOnce(json(200, ACTIVE_PREVIEW))
        .mockResolvedValueOnce(json(400, { error: 'invite_invalid', reason }));
      expect(await rigShareController.acceptInviteLink({ link: LINK })).toMatchObject({
        success: false,
        error: { kind },
      });
    }
  });

  it('keeps both addresses on an email invite opened by the wrong account, and names them', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, ACTIVE_PREVIEW))
      .mockResolvedValueOnce(
        json(400, { error: 'invite_invalid', reason: 'email_mismatch', invitedHint: 'h•••@gmail.com', signedInAs: 'x@y.com' })
      );
    expect(await rigShareController.acceptInviteLink({ link: LINK })).toEqual({
      success: false,
      error: {
        kind: 'wrongAccount',
        status: 400,
        message: "This invite is for h•••@gmail.com. You're signed in as x@y.com.",
        invitedHint: 'h•••@gmail.com',
        signedInAs: 'x@y.com',
      },
    });
  });

  it('says the 403 and 503 refusals in plain words, never the relay code', async () => {
    const cases: Array<[number, string, string, string]> = [
      [403, 'invite_for_someone_else', 'wrongAccount', 'This invite was sent to someone else. Ask them to invite your account.'],
      [403, 'account_deletion_pending', 'relay', 'Your account is set to be deleted. Sign in again to keep it, then open the invite again.'],
      [503, 'clerk_unavailable', 'network', 'Rig couldn’t check your account just now. Try again in a minute.'],
    ];
    for (const [status, code, kind, message] of cases) {
      fetchMock.mockResolvedValueOnce(json(200, ACTIVE_PREVIEW)).mockResolvedValueOnce(json(status, { error: code }));
      const result = await rigShareController.acceptInviteLink({ link: LINK });
      expect(result).toEqual({ success: false, error: { kind, message, status } });
      expect(message).not.toMatch(/relay|_/);
    }
  });

  it('says notFound for an unknown secret', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { error: 'not_found' }));
    expect(await rigShareController.acceptInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'notFound' },
    });
  });

  it('still accepts when the preview hiccups, just without a name', async () => {
    fetchMock
      .mockResolvedValueOnce(json(429, { error: 'rate_limited' }))
      .mockResolvedValueOnce(json(201, { bindingId: 'b_1', device: {}, token: {}, member: null }));
    expect(await rigShareController.acceptInviteLink({ link: LINK })).toEqual({
      success: true,
      data: { bindingId: 'b_1', spaceName: null, becameMember: false },
    });
  });

  it('says network when the relay is unreachable, and never logs or returns the secret', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError(`fetch failed for ${RELAY}/v1/invites/${SECRET}`)
    );

    const result = await rigShareController.acceptInviteLink({ link: LINK });

    expect(result).toMatchObject({ success: false, error: { kind: 'network' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(mocks.warn).toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(SECRET);
  });
});

describe('previewInviteLink', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('RIG_RELAY_URL', RELAY);
    mocks.readRelayToken.mockReset().mockResolvedValue(null);
    mocks.warn.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('names the space and the inviter from the public preview, without a sign-in', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ...ACTIVE_PREVIEW, inviter: { name: 'Ada', email: 'ada@example.com' } })
    );

    const result = await rigShareController.previewInviteLink({ link: LINK });

    expect(result).toEqual({ success: true, data: { spaceName: 'growth', inviterName: 'Ada', emailHint: null } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${RELAY}/v1/invites/${SECRET}`);
    expect(init.headers.authorization).toBeUndefined();
    expect(mocks.readRelayToken).not.toHaveBeenCalled();
  });

  it("falls back to the inviter's email, then to nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ...ACTIVE_PREVIEW, inviter: { name: null, email: 'ada@example.com' } })
    );
    expect(await rigShareController.previewInviteLink({ link: LINK })).toEqual({
      success: true,
      data: { spaceName: 'growth', inviterName: 'ada@example.com', emailHint: null },
    });
    fetchMock.mockResolvedValueOnce(json(200, { status: 'active', binding: { name: null }, inviter: {} }));
    expect(await rigShareController.previewInviteLink({ link: LINK })).toEqual({
      success: true,
      data: { spaceName: null, inviterName: null, emailHint: null },
    });
  });

  it('says who an email invite is for, masked as the relay sent it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...ACTIVE_PREVIEW, emailHint: 'h•••@gmail.com' }));
    expect(await rigShareController.previewInviteLink({ link: LINK })).toEqual({
      success: true,
      data: { spaceName: 'growth', inviterName: null, emailHint: 'h•••@gmail.com' },
    });
  });

  it('says revoked, expired, or notFound when the invite is no good', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...ACTIVE_PREVIEW, status: 'revoked' }));
    expect(await rigShareController.previewInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'revoked' },
    });
    fetchMock.mockResolvedValueOnce(json(200, { ...ACTIVE_PREVIEW, status: 'expired' }));
    expect(await rigShareController.previewInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'expired' },
    });
    fetchMock.mockResolvedValueOnce(json(404, { error: 'not_found' }));
    expect(await rigShareController.previewInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'notFound' },
    });
  });

  it('refuses to send the secret to an untrusted relay', async () => {
    vi.stubEnv('RIG_RELAY_URL', 'https://evil.example');
    expect(await rigShareController.previewInviteLink({ link: LINK })).toMatchObject({
      success: false,
      error: { kind: 'relay' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never logs or returns the secret when the relay is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${RELAY}/v1/invites/${SECRET}`));
    const result = await rigShareController.previewInviteLink({ link: LINK });
    expect(result).toMatchObject({ success: false, error: { kind: 'network' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(SECRET);
  });
});
