import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestWirePort: vi.fn<(channel: string) => Promise<void>>(),
  awaitWirePort: vi.fn(),
  client: vi.fn(),
  connect: vi.fn(),
  domPortTransport: vi.fn(),
}));

vi.mock('@emdash/wire', () => ({
  awaitWirePort: mocks.awaitWirePort,
  client: mocks.client,
  connect: mocks.connect,
  domPortTransport: mocks.domPortTransport,
}));

vi.mock('@emdash/core/workspace-server/agent-config', () => ({ agentConfigContract: {} }));

import {
  AGENT_RUNTIME_UNAVAILABLE_MESSAGE,
  getAgentConfigRuntimeClient,
  resetAgentConfigRuntimeClient,
} from './runtime-client';

/**
 * The renderer memoizes its wire client; before this round a FAILED connect
 * was memoized too, so once the main process's agent-config worker missed
 * its start (a slow cold start on the fresh-user regression run) provider
 * sign-in stayed broken for the whole session even after main's retry
 * brought the worker up — and the dialog showed the raw IPC error.
 */
describe('getAgentConfigRuntimeClient', () => {
  beforeEach(() => {
    resetAgentConfigRuntimeClient();
    mocks.requestWirePort.mockReset();
    mocks.awaitWirePort.mockReset().mockResolvedValue({});
    mocks.client.mockReset().mockReturnValue({ fake: 'client' });
    mocks.connect.mockReset().mockReturnValue({});
    mocks.domPortTransport.mockReset().mockReturnValue({});
    (globalThis as { window?: unknown }).window = {
      electronAPI: { requestWirePort: mocks.requestWirePort },
    };
  });

  it('turns the missing-handler IPC error into the human message and retries next time', async () => {
    mocks.requestWirePort.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'agent-config-wire:connect': Error: No handler registered for 'agent-config-wire:connect'"
      )
    );
    await expect(getAgentConfigRuntimeClient()).rejects.toThrow(AGENT_RUNTIME_UNAVAILABLE_MESSAGE);

    // The worker came up in the meantime (main retried): the next call must
    // connect afresh rather than replay the memoized rejection.
    mocks.requestWirePort.mockResolvedValueOnce(undefined);
    await expect(getAgentConfigRuntimeClient()).resolves.toEqual({ fake: 'client' });
    expect(mocks.requestWirePort).toHaveBeenCalledTimes(2);
  });

  it('passes other connect errors through untouched, still without memoizing them', async () => {
    mocks.requestWirePort.mockRejectedValueOnce(new Error('port closed'));
    await expect(getAgentConfigRuntimeClient()).rejects.toThrow('port closed');

    mocks.requestWirePort.mockResolvedValueOnce(undefined);
    await expect(getAgentConfigRuntimeClient()).resolves.toEqual({ fake: 'client' });
  });

  it('memoizes a successful client', async () => {
    mocks.requestWirePort.mockResolvedValue(undefined);
    const first = await getAgentConfigRuntimeClient();
    const second = await getAgentConfigRuntimeClient();
    expect(second).toBe(first);
    expect(mocks.requestWirePort).toHaveBeenCalledTimes(1);
  });
});
