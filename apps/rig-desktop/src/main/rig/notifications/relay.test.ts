import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listNotifications, toNotification } from './relay';

/** The list route's query string: the Room's For you asks for one Space's rows with `bindingId`. */

vi.mock('../account', () => ({
  resolveContext: async () => ({ url: 'https://relay.test', token: 't' }),
  isError: (v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => {}, info: () => {}, error: () => {} } }));

describe('listNotifications', () => {
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ notifications: [] }), { status: 200 });
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the Space as bindingId when asked, and not otherwise', async () => {
    await listNotifications({ tier: 'direct', limit: 100, bindingId: 'bnd_a' });
    await listNotifications({ tier: 'direct', limit: 50 });
    const first = new URL(urls[0]!);
    expect(first.pathname).toBe('/v1/me/notifications');
    expect(first.searchParams.get('bindingId')).toBe('bnd_a');
    expect(first.searchParams.get('limit')).toBe('100');
    expect(first.searchParams.get('tier')).toBe('direct');
    expect(new URL(urls[1]!).searchParams.has('bindingId')).toBe(false);
  });

  it('reports a relay that rejects the param as a failure with its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_binding_id' }), { status: 400 })
      )
    );
    const result = await listNotifications({ tier: 'direct', bindingId: 'bnd_a' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatchObject({ status: 400 });
  });
});

describe('toNotification', () => {
  const wire = {
    id: '7',
    type: 'comment',
    tier: 'ambient',
    bindingId: 'bnd_a',
    spaceName: 'Launch',
    actor: { kind: 'user', userId: 'u_maya', name: 'Maya', agent: null },
    messageId: 'm1',
    messageSeq: 3,
    path: 'docs/plan.md',
    title: 'Maya commented on plan.md in Launch',
    body: 'looks short',
    createdAt: '2026-10-08T10:00:00Z',
    readAt: null,
  };

  it("keeps a comment's file author, and leaves it out for a relay that doesn't send one", () => {
    expect(toNotification({ ...wire, fileAuthorUserId: 'u_me' })?.fileAuthorUserId).toBe('u_me');
    expect(toNotification({ ...wire, fileAuthorUserId: null })).not.toHaveProperty('fileAuthorUserId');
    expect(toNotification(wire)).not.toHaveProperty('fileAuthorUserId');
  });
});
