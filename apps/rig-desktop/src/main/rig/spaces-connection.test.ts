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
const isError = vi.fn((v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object));
vi.mock('./account', () => ({
  resolveContext: (...args: unknown[]) => resolveContext(...args),
  isError: (v: unknown) => isError(v),
}));

const whoami = vi.fn();
const mintRealtimeTicket = vi.fn();
const listMembers = vi.fn();
const listMessages = vi.fn();
const getSessionEvents = vi.fn();
const postMessage = vi.fn();
const createAgentRequest = vi.fn();
vi.mock('./spaces/relay-api', () => ({
  createHttpSpacesRelayApi: () => ({
    whoami: (...args: unknown[]) => whoami(...args),
    mintRealtimeTicket: (...args: unknown[]) => mintRealtimeTicket(...args),
    listMembers: (...args: unknown[]) => listMembers(...args),
    listMessages: (...args: unknown[]) => listMessages(...args),
    getSessionEvents: (...args: unknown[]) => getSessionEvents(...args),
    postMessage: (...args: unknown[]) => postMessage(...args),
    createAgentRequest: (...args: unknown[]) => createAgentRequest(...args),
  }),
}));

describe('rigSpacesConnectionController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getConnectionInfo returns relayUrl/wsUrl/selfUserId and NO token field', async () => {
    resolveContext.mockResolvedValue({ url: 'https://relay.test', token: 'super-secret-pat' });
    whoami.mockResolvedValue(ok({ id: 'u1' }));

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
    expect(whoami).not.toHaveBeenCalled();
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
