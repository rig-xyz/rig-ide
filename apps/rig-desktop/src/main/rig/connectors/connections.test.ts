import { describe, expect, it, vi } from 'vitest';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createConnections, loginFromIdToken, pickLogin, type CallbackListener, type ConnectionsDeps, type OAuthSteps } from './connections';

const METADATA = { issuer: 'https://as.example', authorization_endpoint: 'https://as.example/authorize', token_endpoint: 'https://as.example/token', response_types_supported: ['code'] } as AuthorizationServerMetadata;

function harness(opts: { account?: string | null; now?: number } = {}) {
  const secrets = new Map<string, string>();
  let now = opts.now ?? 1_000_000;
  let pending: { resolve: (p: URLSearchParams) => void } | null = null;
  const listener = (): Promise<CallbackListener> => {
    let resolve!: (p: URLSearchParams) => void;
    const wait = new Promise<URLSearchParams>((r) => (resolve = r));
    pending = { resolve };
    return Promise.resolve({ redirectUri: 'http://127.0.0.1:33418/connectors/callback', wait, close: vi.fn() });
  };
  const oauth: OAuthSteps = {
    discover: vi.fn(async () => ({ issuer: 'https://as.example', metadata: METADATA })),
    register: vi.fn(async (_i, _m, redirectUri) => ({ clientId: 'client-1', redirectUri })),
    authorizeUrl: vi.fn(async (_i, _m, _c, state) => ({ url: `https://as.example/authorize?state=${state}`, codeVerifier: 'verifier' })),
    exchange: vi.fn(async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' })),
    refresh: vi.fn(async () => ({ access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' })),
  };
  const opened: string[] = [];
  const deps: ConnectionsDeps = {
    secrets: {
      getSecret: async (k) => secrets.get(k) ?? null,
      setSecret: async (k, v) => void secrets.set(k, v),
      deleteSecret: async (k) => void secrets.delete(k),
    },
    accountId: async () => (opts.account === undefined ? 'user-1' : opts.account),
    openBrowser: async (url) => void opened.push(url),
    oauth,
    listen: listener,
    now: () => now,
    identify: vi.fn(async () => 'dylan@example.com'),
  };
  const connections = createConnections(deps);
  /** Simulates the vendor redirecting back, echoing the state from the opened URL. */
  let answered = 0;
  const redirect = async (params: Record<string, string>, stateOverride?: string) => {
    await vi.waitFor(() => expect(opened.length).toBe(answered + 1));
    answered += 1;
    const state = stateOverride ?? new URL(opened[opened.length - 1]!).searchParams.get('state')!;
    pending!.resolve(new URLSearchParams({ state, ...params }));
  };
  return { connections, secrets, oauth, opened, redirect, deps, advance: (ms: number) => (now += ms) };
}

describe('connections', () => {
  it('starts with nothing connected', async () => {
    const { connections } = harness();
    const list = await connections.list();
    expect(list.every((s) => s.state === 'not_connected')).toBe(true);
    expect(list.map((s) => s.id)).toContain('linear');
  });

  it('signs in: registers once, opens the browser, stores tokens, then reports connected', async () => {
    const { connections, oauth, opened, redirect, secrets } = harness();
    const result = connections.connect('linear');
    await redirect({ code: 'the-code' });
    expect(await result).toEqual({ ok: true });
    expect(opened[0]).toContain('https://as.example/authorize');
    expect(oauth.register).toHaveBeenCalledTimes(1);
    expect(oauth.exchange).toHaveBeenCalledWith('https://as.example', METADATA, expect.objectContaining({ clientId: 'client-1' }), 'the-code', 'verifier', 'https://mcp.linear.app/mcp');
    expect((await connections.list()).find((s) => s.id === 'linear')?.state).toBe('connected');
    expect([...secrets.keys()]).toEqual(['connectors:user-1:linear']);

    // A second sign-in reuses the registration.
    const again = connections.connect('linear');
    await redirect({ code: 'code-2' });
    await again;
    expect(oauth.register).toHaveBeenCalledTimes(1);
  });

  it('never exposes tokens through list()', async () => {
    const { connections, redirect } = harness();
    const result = connections.connect('notion');
    await redirect({ code: 'c' });
    await result;
    expect(JSON.stringify(await connections.list())).not.toContain('access-1');
  });

  it('rejects a redirect whose state does not match', async () => {
    const { connections, redirect, oauth } = harness();
    const result = connections.connect('linear');
    await redirect({ code: 'c' }, 'someone-elses-state');
    expect(await result).toMatchObject({ ok: false, reason: 'failed' });
    expect(oauth.exchange).not.toHaveBeenCalled();
  });

  it('reports a declined consent as denied', async () => {
    const { connections, redirect } = harness();
    const result = connections.connect('linear');
    await redirect({ error: 'access_denied' });
    expect(await result).toEqual({ ok: false, reason: 'denied' });
  });

  it('cancels an in-flight sign-in', async () => {
    const { connections, opened } = harness();
    const result = connections.connect('linear');
    await vi.waitFor(() => expect(opened.length).toBe(1));
    connections.cancel('linear');
    expect(await result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('times out when the browser never comes back', async () => {
    const h = harness();
    const connections = createConnections({ ...h.deps, timeoutMs: 20 });
    expect(await connections.connect('linear')).toEqual({ ok: false, reason: 'timeout' });
  });

  it('refuses to connect while signed out of rig', async () => {
    const { connections, opened } = harness({ account: null });
    expect(await connections.connect('linear')).toMatchObject({ ok: false, reason: 'failed' });
    expect(opened).toEqual([]);
  });

  it('keeps logins per rig account', async () => {
    const h = harness();
    const result = h.connections.connect('linear');
    await h.redirect({ code: 'c' });
    await result;
    const other = createConnections({ ...h.deps, accountId: async () => 'user-2' });
    expect((await other.list()).find((s) => s.id === 'linear')?.state).toBe('not_connected');
  });

  describe('forSession', () => {
    async function connected(id: 'linear' | 'notion' = 'linear') {
      const h = harness();
      const result = h.connections.connect(id);
      await h.redirect({ code: 'c' });
      await result;
      return h;
    }

    it('hands connected tools over as http servers with a bearer header, and lists the rest as gaps', async () => {
      const { connections } = await connected();
      const { servers, gaps } = await connections.forSession(['linear', 'notion']);
      expect(servers).toEqual([
        { type: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'Authorization', value: 'Bearer access-1' }] },
      ]);
      expect(gaps).toEqual([{ id: 'notion', state: 'not_connected' }]);
    });

    it('refreshes a token that is about to expire', async () => {
      const h = await connected();
      h.advance(3600_000 - 60_000);
      const { servers } = await h.connections.forSession(['linear']);
      expect(h.oauth.refresh).toHaveBeenCalledWith('https://as.example', METADATA, expect.anything(), 'refresh-1', 'https://mcp.linear.app/mcp');
      expect(servers[0]?.headers[0]?.value).toBe('Bearer access-2');
      // The refresh token survives a refresh response that doesn't rotate it.
      const stored = JSON.parse(h.secrets.get('connectors:user-1:linear')!);
      expect(stored.tokens.refreshToken).toBe('refresh-1');
    });

    it('marks a login expired when the refresh is refused after the token lapsed', async () => {
      const h = await connected();
      vi.mocked(h.oauth.refresh).mockRejectedValueOnce(new Error('invalid_grant'));
      h.advance(3600_000 + 1);
      const { servers, gaps } = await h.connections.forSession(['linear']);
      expect(servers).toEqual([]);
      expect(gaps).toEqual([{ id: 'linear', state: 'expired' }]);
      expect((await h.connections.list()).find((s) => s.id === 'linear')?.state).toBe('expired');
    });

    it('keeps using a still-valid token when a refresh fails', async () => {
      const h = await connected();
      vi.mocked(h.oauth.refresh).mockRejectedValueOnce(new Error('network'));
      h.advance(3600_000 - 60_000);
      const { servers } = await h.connections.forSession(['linear']);
      expect(servers[0]?.headers[0]?.value).toBe('Bearer access-1');
    });
  });

  it('forgets a login on disconnect', async () => {
    const { connections, redirect, secrets } = harness();
    const result = connections.connect('linear');
    await redirect({ code: 'c' });
    await result;
    await connections.disconnect('linear');
    expect(secrets.size).toBe(0);
    expect((await connections.forSession(['linear'])).gaps).toEqual([{ id: 'linear', state: 'not_connected' }]);
  });
});

describe('who you are signed in as', () => {
  it('learns it right after connecting, and lists it with the connection', async () => {
    const h = harness();
    const result = h.connections.connect('linear');
    await h.redirect({ code: 'c' });
    await result;
    await vi.waitFor(() => expect(h.deps.identify).toHaveBeenCalledWith('linear', 'https://mcp.linear.app/mcp', 'access-1'));
    await vi.waitFor(async () =>
      expect((await h.connections.list()).find((s) => s.id === 'linear')).toEqual({ id: 'linear', state: 'connected', account: 'dylan@example.com' })
    );
  });

  it('asks at most once a day when the server has no answer', async () => {
    const h = harness();
    vi.mocked(h.deps.identify!).mockResolvedValue(null);
    const result = h.connections.connect('linear');
    await h.redirect({ code: 'c' });
    await result;
    await vi.waitFor(() => expect(JSON.parse(h.secrets.get('connectors:user-1:linear')!).loginTriedAt).toBeTypeOf('number'));
    await h.connections.list();
    await h.connections.list();
    expect(h.deps.identify).toHaveBeenCalledTimes(1);
    // A day later it asks again (the server may have learned to answer, or rig may know its tool by then).
    h.advance(24 * 60 * 60 * 1000 + 1);
    await h.connections.list();
    await vi.waitFor(() => expect(h.deps.identify).toHaveBeenCalledTimes(2));
  });

  it('never lets a failed lookup break the connection', async () => {
    const h = harness();
    vi.mocked(h.deps.identify!).mockRejectedValue(new Error('boom'));
    const result = h.connections.connect('linear');
    await h.redirect({ code: 'c' });
    expect(await result).toEqual({ ok: true });
    expect((await h.connections.list()).find((s) => s.id === 'linear')?.state).toBe('connected');
  });
});

describe('pickLogin', () => {
  it('prefers an email anywhere in the answer', () => {
    expect(pickLogin('User: Dylan (dylan@example.com), admin')).toBe('dylan@example.com');
    expect(pickLogin({ user: { name: 'Dylan', email: 'd@x.io' } })).toBe('d@x.io');
  });

  it('falls back to a username or name', () => {
    expect(pickLogin({ user: { username: 'dtsbourg' } })).toBe('dtsbourg');
    expect(pickLogin('{"displayName":"Dylan B"}')).toBe('Dylan B');
    expect(pickLogin('no idea')).toBeNull();
  });
});

describe('loginFromIdToken', () => {
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  it('reads the email, else the username or name', () => {
    expect(loginFromIdToken(jwt({ email: 'd@x.io', name: 'Dylan' }))).toBe('d@x.io');
    expect(loginFromIdToken(jwt({ preferred_username: 'dtsbourg' }))).toBe('dtsbourg');
    expect(loginFromIdToken('not-a-jwt')).toBeNull();
  });
});
