import { ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `spaces-connection.ts` proxies every relay call the Room needs through
 * `SpacesRelayApi` (mocked here) — this file exists to prove the one
 * security-relevant contract change directly: `getConnectionInfo` no
 * longer hands the renderer this device's PAT (or any token at all), and
 * `mintRealtimeTicket`/the HTTP proxy methods delegate to the relay client
 * rather than re-deriving anything themselves.
 */

const resolveContext = vi.fn();
const resolveSelfUserId = vi.fn();
const isError = vi.fn((v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object));
vi.mock('./account', () => ({
  resolveContext: (...args: unknown[]) => resolveContext(...args),
  resolveSelfUserId: (...args: unknown[]) => resolveSelfUserId(...args),
  isError: (v: unknown) => isError(v),
}));

const whoami = vi.fn();
const mintRealtimeTicket = vi.fn();
const listMembers = vi.fn();
const listMessages = vi.fn();
const getSessionEvents = vi.fn();
const postMessage = vi.fn();
const createAgentRequest = vi.fn();
const getThemes = vi.fn();
const getThemeEvents = vi.fn();
const setThemesEnabled = vi.fn();
vi.mock('./spaces/relay-api', () => ({
  createHttpSpacesRelayApi: () => ({
    whoami: (...args: unknown[]) => whoami(...args),
    mintRealtimeTicket: (...args: unknown[]) => mintRealtimeTicket(...args),
    listMembers: (...args: unknown[]) => listMembers(...args),
    listMessages: (...args: unknown[]) => listMessages(...args),
    getSessionEvents: (...args: unknown[]) => getSessionEvents(...args),
    postMessage: (...args: unknown[]) => postMessage(...args),
    createAgentRequest: (...args: unknown[]) => createAgentRequest(...args),
    getThemes: (...args: unknown[]) => getThemes(...args),
    getThemeEvents: (...args: unknown[]) => getThemeEvents(...args),
    setThemesEnabled: (...args: unknown[]) => setThemesEnabled(...args),
  }),
}));

describe('rigSpacesConnectionController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getConnectionInfo returns relayUrl/wsUrl/selfUserId and NO token field', async () => {
    resolveContext.mockResolvedValue({ url: 'https://relay.test', token: 'super-secret-pat' });
    resolveSelfUserId.mockResolvedValue(ok('u1'));

    const { rigSpacesConnectionController } = await import('./spaces-connection');
    const result = await rigSpacesConnectionController.getConnectionInfo();

    expect(result).toEqual({
      success: true,
      data: {
        relayUrl: 'https://relay.test',
        wsUrl: 'wss://relay.test/v1/realtime',
        selfUserId: 'u1',
      },
    });
    // The exact security property this task is about: no `token` key anywhere in the response.
    expect(Object.keys((result as { data: object }).data)).not.toContain('token');
  });

  it('getConnectionInfo surfaces a resolveContext error without calling the relay', async () => {
    resolveContext.mockResolvedValue({ kind: 'notSignedIn', message: 'not signed in' });

    const { rigSpacesConnectionController } = await import('./spaces-connection');
    const result = await rigSpacesConnectionController.getConnectionInfo();

    expect(result.success).toBe(false);
    expect(resolveSelfUserId).not.toHaveBeenCalled();
    expect(whoami).not.toHaveBeenCalled();
  });

  it('previewDraft posts the draft to the relay and reads anything unclear as "none"', async () => {
    resolveContext.mockResolvedValue({ url: 'https://relay.test/', token: 'pat' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ answersTo: 'm9', agent: 'claude', confidence: 0.8 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { rigSpacesConnectionController, parseDraftPreview } = await import('./spaces-connection');
      const result = await rigSpacesConnectionController.previewDraft({ bindingId: 'b1', text: 'ok not this one' });
      expect(result).toEqual({ answersTo: 'm9', agent: 'claude', confidence: 0.8 });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://relay.test/v1/me/bindings/b1/draft-preview');
      expect(JSON.parse(String(init.body))).toEqual({ text: 'ok not this one' });

      fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 429 }));
      expect(await rigSpacesConnectionController.previewDraft({ bindingId: 'b1', text: 'x' })).toEqual({
        answersTo: null,
        agent: null,
        confidence: 0,
      });
      expect(parseDraftPreview({ answersTo: 'm9', agent: 'gemini', confidence: 1 }).answersTo).toBeNull();
      expect(parseDraftPreview({ answersTo: null, agent: null, confidence: 0 }).answersTo).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('parseDraftPreview reads who the draft is for and what the router would do, when the relay says', async () => {
    const { parseDraftPreview } = await import('./spaces-connection');
    const recipient = { kind: 'agent', agentId: 'ag1', agent: 'codex', ownerUserId: 'u1' };
    expect(parseDraftPreview({ answersTo: null, agent: null, confidence: 0.9, recipient, action: 'ask' })).toEqual({
      answersTo: null,
      agent: null,
      confidence: 0,
      recipient,
      action: 'ask',
    });
    expect(parseDraftPreview({ answersTo: 'm9', agent: 'claude', confidence: 0.8, recipient: { kind: 'person', userId: 'u2' }, action: 'none' })).toEqual({
      answersTo: 'm9',
      agent: 'claude',
      confidence: 0.8,
      recipient: { kind: 'person', userId: 'u2' },
      action: 'none',
    });
    // Anything malformed is left out, so the composer behaves as with an older relay.
    expect(parseDraftPreview({ answersTo: null, recipient: { kind: 'agent', agent: 'gemini' }, action: 'shout' })).toEqual({
      answersTo: null,
      agent: null,
      confidence: 0,
    });
  });

  it('the themes calls delegate to the relay client, an unsupported answer passing through as data', async () => {
    getThemes.mockResolvedValue(ok({ supported: false }));
    getThemeEvents.mockResolvedValue(
      ok({ supported: true, data: { events: [], nextCursor: null, lastId: null } })
    );
    setThemesEnabled.mockResolvedValue(ok({ supported: true, data: { enabled: true } }));

    const { rigSpacesConnectionController } = await import('./spaces-connection');
    expect(await rigSpacesConnectionController.getThemes({ bindingId: 'b1' })).toEqual({
      success: true,
      data: { supported: false },
    });
    await rigSpacesConnectionController.getThemeEvents({ bindingId: 'b1', after: '7' });
    await rigSpacesConnectionController.setThemesEnabled({ bindingId: 'b1', enabled: true });
    expect(getThemes).toHaveBeenCalledWith('b1');
    expect(getThemeEvents).toHaveBeenCalledWith('b1', '7');
    expect(setThemesEnabled).toHaveBeenCalledWith('b1', true);
  });

  it('mintRealtimeTicket delegates to the relay client for the given binding', async () => {
    mintRealtimeTicket.mockResolvedValue(ok({ ticket: 'rrtk_abc', expiresAt: '2026-09-23T00:10:00Z' }));

    const { rigSpacesConnectionController } = await import('./spaces-connection');
    const result = await rigSpacesConnectionController.mintRealtimeTicket({ bindingId: 'b1' });

    expect(mintRealtimeTicket).toHaveBeenCalledWith('b1');
    expect(result).toEqual({ success: true, data: { ticket: 'rrtk_abc', expiresAt: '2026-09-23T00:10:00Z' } });
  });

  it('listMembers/listMessages/getSessionEvents/postMessage/requestOwnAgent all proxy through the same relay client', async () => {
    listMembers.mockResolvedValue(ok([]));
    listMessages.mockResolvedValue(ok([]));
    getSessionEvents.mockResolvedValue(ok({ run: {}, events: [] }));
    postMessage.mockResolvedValue(ok({ id: 'm1' }));
    createAgentRequest.mockResolvedValue(ok({ id: 'req1' }));

    const { rigSpacesConnectionController } = await import('./spaces-connection');
    await rigSpacesConnectionController.listMembers({ bindingId: 'b1' });
    await rigSpacesConnectionController.listMessages({ bindingId: 'b1', query: { latest: 10 } });
    await rigSpacesConnectionController.getSessionEvents({ bindingId: 'b1', runId: 'run1', after: 5 });
    await rigSpacesConnectionController.postMessage({ bindingId: 'b1', body: 'hi', kind: 'text' });
    await rigSpacesConnectionController.requestOwnAgent({
      bindingId: 'b1',
      targetOwnerUserId: 'u1',
      targetAgent: 'claude',
      prompt: 'do it',
    });

    expect(listMembers).toHaveBeenCalledWith('b1');
    expect(listMessages).toHaveBeenCalledWith('b1', { latest: 10 });
    expect(getSessionEvents).toHaveBeenCalledWith('b1', 'run1', 5);
    expect(postMessage).toHaveBeenCalledWith('b1', { body: 'hi', kind: 'text', meta: undefined });
    expect(createAgentRequest).toHaveBeenCalledWith('b1', {
      targetOwnerUserId: 'u1',
      targetAgent: 'claude',
      prompt: 'do it',
      sourceMessageId: undefined,
    });
  });
});

describe('listSpaceSkillsIn — the space folder\'s own skills for the / palette', () => {
  it('reads name and description from each .claude/skills/<name>/SKILL.md, skipping folders without one', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'space-'));
    mkdirSync(join(root, '.claude', 'skills', 'weekly-report'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'skills', 'weekly-report', 'SKILL.md'),
      '---\nname: weekly-report\ndescription: Summarise signups for the week\n---\nBody'
    );
    mkdirSync(join(root, '.claude', 'skills', 'not-a-skill'), { recursive: true });

    const { listSpaceSkillsIn } = await import('./spaces-connection');
    expect(await listSpaceSkillsIn(root)).toEqual([
      { cmd: '/weekly-report', name: 'weekly-report', desc: 'Summarise signups for the week' },
    ]);
    expect(await listSpaceSkillsIn(join(root, 'missing'))).toEqual([]);
  });
});

