import { err, ok } from '@emdash/shared';
import { describe, expect, it } from 'vitest';
import {
  claimAndDispatchQueued,
  claimOne,
  markRequestSettled,
  RequestClaimPoller,
  type ClaimDispatchResult,
} from './request-claim';
import type { AgentRequest, RelayApiError, SpacesRelayApi } from './relay-api';

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    id: 'req1',
    bindingId: 'b1',
    targetOwnerUserId: 'me',
    targetAgent: 'claude',
    requestedByUserId: 'other',
    sourceMessageId: null,
    prompt: 'do the thing',
    status: 'queued',
    claimedByDeviceId: null,
    claimedAt: null,
    runId: null,
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-23T00:00:00Z',
    ...overrides,
  };
}

function notImplemented(name: string) {
  return async () => {
    throw new Error(`${name} should not be called in this test`);
  };
}

/**
 * A single shared in-memory "backend" simulating the relay's atomic claim
 * (`UPDATE ... WHERE status = 'queued'`) — two `SpacesRelayApi` instances can
 * be built against the SAME store to simulate two devices racing the same
 * request, the way two real devices would race the same relay row.
 */
function makeSharedStore(requests: AgentRequest[]) {
  const byId = new Map(requests.map((r) => [r.id, { ...r }]));
  const patches: Array<{ id: string; status: string; runId?: string }> = [];

  function apiFor(): SpacesRelayApi {
    return {
      whoami: async () => ok({ id: 'me' }),
      createSession: notImplemented('createSession'),
      patchSession: notImplemented('patchSession'),
      postSessionEvents: notImplemented('postSessionEvents'),
      getSessionEvents: notImplemented('getSessionEvents'),
      createAgentRequest: notImplemented('createAgentRequest'),
      listAgentRequests: async (status = 'queued') =>
        ok(Array.from(byId.values()).filter((r) => r.status === status)),
      // The one method that must behave atomically: only the FIRST caller to
      // reach a still-'queued' row wins, matching the relay's single
      // `UPDATE ... WHERE status = 'queued'`.
      claimAgentRequest: async (_bindingId, id, deviceId) => {
        const row = byId.get(id);
        if (!row) return err<RelayApiError>({ kind: 'relay', status: 404, message: 'not_found' });
        if (row.status !== 'queued') {
          return err<RelayApiError>({ kind: 'relay', status: 409, message: 'already_claimed' });
        }
        row.status = 'claimed';
        row.claimedByDeviceId = deviceId;
        return ok({ ...row });
      },
      patchAgentRequest: async (_bindingId, id, patch) => {
        const row = byId.get(id);
        if (!row) return err<RelayApiError>({ kind: 'relay', status: 404, message: 'not_found' });
        row.status = patch.status;
        if (patch.runId) row.runId = patch.runId;
        patches.push({ id, status: patch.status, runId: patch.runId });
        return ok({ ...row });
      },
      listMembers: notImplemented('listMembers'),
      listMessages: notImplemented('listMessages'),
      postMessage: notImplemented('postMessage'),
    };
  }

  return { apiFor, patches, get: (id: string) => byId.get(id) };
}

describe('claimOne / claimAndDispatchQueued', () => {
  it('claims, dispatches, and marks the request running with the new runId', async () => {
    const store = makeSharedStore([makeRequest()]);
    const dispatched: AgentRequest[] = [];
    await claimOne(
      store.apiFor(),
      'device-a',
      async (request): Promise<ClaimDispatchResult> => {
        dispatched.push(request);
        return { runId: 'run-1' };
      },
      makeRequest()
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].status).toBe('claimed');
    expect(store.get('req1')?.status).toBe('running');
    expect(store.get('req1')?.runId).toBe('run-1');
    expect(store.patches).toEqual([{ id: 'req1', status: 'running', runId: 'run-1' }]);
  });

  it('marks the request failed when local dispatch fails, without throwing', async () => {
    const store = makeSharedStore([makeRequest()]);
    await claimOne(
      store.apiFor(),
      'device-a',
      async (): Promise<ClaimDispatchResult> => ({ failed: true, reason: 'no such provider' }),
      makeRequest()
    );
    expect(store.get('req1')?.status).toBe('failed');
  });

  it('marks the request failed when dispatch throws', async () => {
    const store = makeSharedStore([makeRequest()]);
    await claimOne(
      store.apiFor(),
      'device-a',
      async () => {
        throw new Error('boom');
      },
      makeRequest()
    );
    expect(store.get('req1')?.status).toBe('failed');
  });

  it('a 409 conflict is a silent no-op — dispatch is never called', async () => {
    const store = makeSharedStore([makeRequest({ status: 'claimed' })]); // already claimed
    let called = false;
    await claimOne(
      store.apiFor(),
      'device-a',
      async (): Promise<ClaimDispatchResult> => {
        called = true;
        return { runId: 'run-1' };
      },
      makeRequest()
    );
    expect(called).toBe(false);
  });

  it('exactly one of two racing devices claims and dispatches the same request', async () => {
    const store = makeSharedStore([makeRequest()]);
    const dispatchedBy: string[] = [];

    const dispatch = (deviceId: string) => async (): Promise<ClaimDispatchResult> => {
      dispatchedBy.push(deviceId);
      return { runId: `run-from-${deviceId}` };
    };

    // Both devices race the SAME request concurrently.
    await Promise.all([
      claimOne(store.apiFor(), 'device-a', dispatch('device-a'), makeRequest()),
      claimOne(store.apiFor(), 'device-b', dispatch('device-b'), makeRequest()),
    ]);

    expect(dispatchedBy).toHaveLength(1); // exactly one device ever dispatched
    expect(store.get('req1')?.status).toBe('running');
    expect(['run-from-device-a', 'run-from-device-b']).toContain(store.get('req1')?.runId);
  });

  it('claimAndDispatchQueued processes every queued request, skipping non-queued ones', async () => {
    const store = makeSharedStore([
      makeRequest({ id: 'q1', status: 'queued' }),
      makeRequest({ id: 'q2', status: 'queued' }),
      makeRequest({ id: 'running1', status: 'running' }),
    ]);
    const dispatched: string[] = [];
    await claimAndDispatchQueued({
      api: store.apiFor(),
      deviceId: 'device-a',
      dispatch: async (request) => {
        dispatched.push(request.id);
        return { runId: `run-${request.id}` };
      },
    });
    expect(dispatched.sort()).toEqual(['q1', 'q2']);
    expect(store.get('running1')?.status).toBe('running'); // untouched
  });

  it('lists no requests and does nothing when listAgentRequests fails', async () => {
    const api: SpacesRelayApi = {
      whoami: async () => ok({ id: 'me' }),
      createSession: notImplemented('createSession'),
      patchSession: notImplemented('patchSession'),
      postSessionEvents: notImplemented('postSessionEvents'),
      getSessionEvents: notImplemented('getSessionEvents'),
      createAgentRequest: notImplemented('createAgentRequest'),
      listAgentRequests: async () => err<RelayApiError>({ kind: 'relay', message: 'down' }),
      claimAgentRequest: notImplemented('claimAgentRequest'),
      patchAgentRequest: notImplemented('patchAgentRequest'),
      listMembers: notImplemented('listMembers'),
      listMessages: notImplemented('listMessages'),
      postMessage: notImplemented('postMessage'),
    };
    await expect(
      claimAndDispatchQueued({ api, deviceId: 'd', dispatch: notImplemented('dispatch') })
    ).resolves.toBeUndefined();
  });
});

describe('markRequestSettled', () => {
  it('patches the request to a terminal status', async () => {
    const store = makeSharedStore([makeRequest({ status: 'running' })]);
    await markRequestSettled(store.apiFor(), { bindingId: 'b1', id: 'req1' }, 'done');
    expect(store.get('req1')?.status).toBe('done');
  });
});

describe('RequestClaimPoller', () => {
  function fakeIntervalClock() {
    const pending: Array<{ cb: () => void; ms: number; handle: number }> = [];
    let nextHandle = 1;
    return {
      setInterval: (cb: () => void, ms: number) => {
        const handle = nextHandle;
        nextHandle += 1;
        pending.push({ cb, ms, handle });
        return handle;
      },
      clearInterval: (handle: unknown) => {
        const idx = pending.findIndex((p) => p.handle === handle);
        if (idx !== -1) pending.splice(idx, 1);
      },
      fireAll: async () => {
        for (const p of [...pending]) {
          p.cb();
          await Promise.resolve();
          await Promise.resolve();
        }
      },
    };
  }

  it('checks immediately on start(), before the interval ever fires', async () => {
    const store = makeSharedStore([makeRequest()]);
    const clock = fakeIntervalClock();
    let dispatchCount = 0;
    const poller = new RequestClaimPoller({
      api: store.apiFor(),
      deviceId: 'device-a',
      dispatch: async () => {
        dispatchCount += 1;
        return { runId: 'run-1' };
      },
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchCount).toBe(1);
    poller.stop();
  });

  it('checkNow() calls made while a check is in flight are coalesced into one re-check, not skipped', async () => {
    const store = makeSharedStore([makeRequest()]);
    let dispatchCount = 0;
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const poller = new RequestClaimPoller({
      api: store.apiFor(),
      deviceId: 'device-a',
      dispatch: async () => {
        dispatchCount += 1;
        await new Promise<void>((resolve) => {
          gate.resolve = resolve;
        });
        return { runId: 'run-1' };
      },
    });

    const first = poller.checkNow();
    // Let the first check's async chain (list -> claim -> dispatch) actually
    // reach `dispatch` and block on it before racing a second `checkNow()`.
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    const second = poller.checkNow();
    expect(dispatchCount).toBe(1); // still inside the first dispatch call

    gate.resolve?.();
    await first;
    await second;
    // The request is already 'running' after the first pass, so the
    // coalesced re-check finds nothing left to claim — dispatch is not
    // called a second time for the same request.
    expect(dispatchCount).toBe(1);
    expect(store.get('req1')?.status).toBe('running');
  });
});
