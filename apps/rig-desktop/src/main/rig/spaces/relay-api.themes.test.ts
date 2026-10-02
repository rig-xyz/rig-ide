import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The themes calls of `createHttpSpacesRelayApi`: shaping, defensive parsing, and 404 as "unsupported". */

const resolveContext = vi.fn();
vi.mock('../account', () => ({
  resolveContext: (...args: unknown[]) => resolveContext(...args),
  isError: (v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SpacesRelayApi themes', () => {
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

  it('getThemes shapes the snapshot: bigint strings to numbers, bad rows dropped', async () => {
    fetchMock.mockResolvedValue(
      json({
        enabled: true,
        themes: [
          {
            id: 'thm_1',
            name: 'Pricing',
            description: 'Plans',
            bornSeq: '12',
            count: 3,
            lastSeq: '40',
          },
          { id: 7, name: 'bad id' },
          {
            id: 'thm_2',
            name: 'Launch',
            description: 'Date',
            bornSeq: '20',
            count: 0,
            lastSeq: '20',
          },
        ],
        assignments: {
          m1: { themeId: 'thm_1', via: 'jev' },
          m2: { themeId: 'thm_1', via: 'nonsense' },
          m3: 'x',
        },
        latestEventId: '55',
      })
    );
    const result = await (await api()).getThemes!('b1');
    expect(result).toEqual({
      success: true,
      data: {
        supported: true,
        data: {
          enabled: true,
          themes: [
            {
              id: 'thm_1',
              name: 'Pricing',
              description: 'Plans',
              bornSeq: 12,
              count: 3,
              lastSeq: 40,
            },
            {
              id: 'thm_2',
              name: 'Launch',
              description: 'Date',
              bornSeq: 20,
              count: 0,
              lastSeq: 20,
            },
          ],
          assignments: { m1: { themeId: 'thm_1', via: 'jev' } },
          latestEventId: '55',
        },
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.test/v1/me/bindings/b1/themes');
    expect(init.method).toBe('GET');
  });

  it('a 404 is "unsupported", for all three calls', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'not_found' }, 404));
    const a = await api();
    expect(await a.getThemes!('b1')).toEqual({ success: true, data: { supported: false } });
    expect(await a.getThemeEvents!('b1', '0')).toEqual({
      success: true,
      data: { supported: false },
    });
    expect(await a.setThemesEnabled!('b1', true)).toEqual({
      success: true,
      data: { supported: false },
    });
    // A relay with no JSON 404 body at all reads the same.
    fetchMock.mockImplementation(async () => new Response('404 Not Found', { status: 404 }));
    expect(await a.getThemes!('b1')).toEqual({ success: true, data: { supported: false } });
  });

  it('other failures stay errors, never "unsupported"', async () => {
    const a = await api();
    fetchMock.mockImplementation(async () => json({ error: 'binding_deleted' }, 410));
    const gone = await a.getThemes!('b1');
    expect(gone.success).toBe(false);
    if (!gone.success)
      expect(gone.error).toMatchObject({ kind: 'relay', status: 410, code: 'binding_deleted' });

    fetchMock.mockImplementation(async () => json({ error: 'forbidden' }, 403));
    expect((await a.setThemesEnabled!('b1', false)).success).toBe(false);

    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });
    expect((await a.getThemeEvents!('b1', '5')).success).toBe(false);

    // A 200 that isn't the snapshot is a failure, not "no themes".
    fetchMock.mockImplementation(async () => json({ nope: true }));
    expect((await a.getThemes!('b1')).success).toBe(false);
    expect((await a.getThemeEvents!('b1', '5')).success).toBe(false);
  });

  it('getThemeEvents asks for one page after the cursor and shapes every event type', async () => {
    fetchMock.mockResolvedValue(
      json({
        events: [
          {
            id: '56',
            atSeq: '41',
            type: 'born',
            payload: { themeId: 'thm_3', name: 'Hiring', description: 'Roles', bornSeq: '41' },
          },
          {
            id: '57',
            atSeq: '41',
            type: 'assign',
            payload: { messageId: 'm9', themeId: 'thm_3', via: 'proposer', jev: { choice: 'x' } },
          },
          {
            id: '58',
            atSeq: '42',
            type: 'move',
            payload: { messageId: 'm9', from: 'thm_3', to: 'thm_1' },
          },
          {
            id: '59',
            atSeq: '42',
            type: 'rename',
            payload: { themeId: 'thm_1', old: 'Pricing', name: 'Plans', description: 'Tiers' },
          },
          { id: '60', atSeq: '43', type: 'merge', payload: { from: 'thm_3', into: 'thm_1' } },
          { id: '61', atSeq: '44', type: 'from_the_future', payload: {} },
          { id: 'x', atSeq: '44', type: 'merge', payload: { from: 'a', into: 'b' } },
          { id: '62', atSeq: '44', type: 'assign', payload: { messageId: 'm9' } },
        ],
        nextCursor: '62',
      })
    );
    const result = await (await api()).getThemeEvents!('b1', '55');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://relay.test/v1/me/bindings/b1/themes/events?after=55');
    expect(result).toEqual({
      success: true,
      data: {
        supported: true,
        data: {
          events: [
            {
              id: '56',
              atSeq: 41,
              type: 'born',
              themeId: 'thm_3',
              name: 'Hiring',
              description: 'Roles',
              bornSeq: 41,
            },
            {
              id: '57',
              atSeq: 41,
              type: 'assign',
              messageId: 'm9',
              themeId: 'thm_3',
              via: 'proposer',
            },
            { id: '58', atSeq: 42, type: 'move', messageId: 'm9', from: 'thm_3', to: 'thm_1' },
            {
              id: '59',
              atSeq: 42,
              type: 'rename',
              themeId: 'thm_1',
              name: 'Plans',
              description: 'Tiers',
            },
            { id: '60', atSeq: 43, type: 'merge', from: 'thm_3', into: 'thm_1' },
          ],
          nextCursor: '62',
          // The unknown type counts toward the cursor, so it moves past it.
          lastId: '62',
        },
      },
    });
  });

  it('getThemeEvents never sends a cursor that is not digits', async () => {
    fetchMock.mockResolvedValue(json({ events: [], nextCursor: null }));
    await (
      await api()
    ).getThemeEvents!('b1', '5&limit=1');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://relay.test/v1/me/bindings/b1/themes/events?after=0');
  });

  it('setThemesEnabled patches {enabled} and returns what the relay stored', async () => {
    fetchMock.mockResolvedValue(json({ enabled: false }));
    const result = await (await api()).setThemesEnabled!('b1', false);
    expect(result).toEqual({ success: true, data: { supported: true, data: { enabled: false } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.test/v1/me/bindings/b1/themes');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('not signed in surfaces the account error without calling the relay', async () => {
    resolveContext.mockResolvedValue({ kind: 'notSignedIn', message: 'not signed in' });
    const result = await (await api()).getThemes!('b1');
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
