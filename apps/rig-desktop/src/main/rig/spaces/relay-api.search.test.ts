import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `searchMessages` of `createHttpSpacesRelayApi`: the query it sends and how it reads the answer. */

const resolveContext = vi.fn();
vi.mock('../account', () => ({
  resolveContext: (...args: unknown[]) => resolveContext(...args),
  isError: (v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SpacesRelayApi searchMessages', () => {
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

  it('sends the query and the page, and reads each match with its message', async () => {
    fetchMock.mockResolvedValue(
      json({
        results: [
          {
            messageId: 'msg_2',
            seq: 12,
            kind: 'answer',
            runId: 'run_1',
            createdAt: '2026-10-05T10:00:00Z',
            snippet: { text: 'The pricing plan', highlights: [{ start: 4, end: 11 }, { start: 'x' }] },
            message: {
              id: 'msg_2',
              seq: '12',
              author: { userId: 'clerk_1', name: 'Sam', avatarUrl: null, kind: 'user' },
              kind: 'session',
              body: 'Asked Claude',
              meta: { runId: 'run_1' },
              createdAt: '2026-10-05T10:00:00Z',
            },
          },
          { messageId: 'msg_bad', seq: 3, kind: 'message' },
        ],
        nextBefore: 12,
      })
    );
    const result = await (await api()).searchMessages!('bnd_1', { q: 'pricing plan', before: 40, limit: 30 });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1/me/bindings/bnd_1/messages/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'pricing plan', before: '40', limit: '30' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nextBefore).toBe(12);
    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0]).toMatchObject({
      messageId: 'msg_2',
      seq: 12,
      kind: 'answer',
      runId: 'run_1',
      snippet: { text: 'The pricing plan', highlights: [{ start: 4, end: 11 }] },
      message: { id: 'msg_2', seq: 12, kind: 'session', meta: { runId: 'run_1' } },
    });
  });

  it('reads the last page as having no next one', async () => {
    fetchMock.mockResolvedValue(json({ results: [], nextBefore: null }));
    const result = await (await api()).searchMessages!('bnd_1', { q: 'x' });
    expect(result).toEqual({ success: true, data: { results: [], nextBefore: null } });
  });
});
