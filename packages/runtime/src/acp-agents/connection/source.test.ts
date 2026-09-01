import type { Client } from '@agentclientprotocol/sdk';
import type { AgentPluginHost, IAcpBehavior } from '@emdash/core/agents/plugins';
import { err, isErr, isOk } from '@emdash/shared';
import { noopLogger } from '@emdash/shared/logger';
import { acquireAsResult } from '@emdash/wire/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, FakeAcpProcessHost, testPluginHost } from '../acp-test-support';
import {
  CONNECTION_GRACE_MS,
  createAcpConnectionSource,
  isAcpConnectionError,
  makeAcpConnectionKey,
} from './source';

/**
 * Fakes ONLY the timer the keep-warm grace window uses — `waitForTeardown`'s
 * `setImmediate` (and the fakes' own microtask plumbing) must stay real.
 */
function useGraceTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

function makeBehavior(agent: FakeAcpAgent): IAcpBehavior {
  return {
    buildSpawn: vi.fn().mockReturnValue({ command: '/fake/agent', args: [], env: {} }),
    connect: agent.behavior.connect,
  };
}

function acquireInput(agent: FakeAcpAgent, workspaceId = 'ws-1') {
  return {
    providerId: 'claude',
    workspaceId,
    cwd: '/tmp/workspace',
    behavior: makeBehavior(agent),
    buildClient: vi.fn(() => ({}) as Client),
  };
}

function waitForTeardown(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sourceDeps(
  host: FakeAcpProcessHost,
  onClosed = vi.fn(),
  agentHost = testPluginHost({ acpBehavior: makeBehavior(new FakeAcpAgent()) })
) {
  return {
    host,
    agentHost,
    logger: noopLogger,
    onClosed,
  };
}

describe('createAcpConnectionSource', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes acquisitions by provider/workspace and refcounts release', async () => {
    useGraceTimers();
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    const first = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    const second = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(host.allHandles).toHaveLength(1);

    await first.data.release();
    expect(host.lastHandle.kill).not.toHaveBeenCalled();
    expect(source.peek(key)).not.toBeUndefined();

    // The last release starts the keep-warm grace window, not a teardown —
    // the pooled process must survive until the window lapses so a prompt
    // follow-up @mention reuses it instead of paying a fresh spawn.
    await second.data.release();
    expect(host.lastHandle.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_MS);
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    await waitForTeardown();
    expect(source.peek(key)).toBeUndefined();
  });

  it('reuses the live process for an acquire inside the grace window', async () => {
    useGraceTimers();
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    const first = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    await first.data.release();
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_MS / 2);

    const second = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    // Same pooled process, no second spawn — and the pending teardown is
    // cancelled: well past the original window, the process still lives.
    expect(host.allHandles).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_MS);
    expect(host.lastHandle.kill).not.toHaveBeenCalled();

    await second.data.release();
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_MS);
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('provisions separate workspaces independently', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));

    await acquireAsResult(
      source,
      makeAcpConnectionKey('claude', 'ws-1'),
      acquireInput(agent, 'ws-1'),
      isAcpConnectionError
    );
    await acquireAsResult(
      source,
      makeAcpConnectionKey('claude', 'ws-2'),
      acquireInput(agent, 'ws-2'),
      isAcpConnectionError
    );

    expect(host.allHandles).toHaveLength(2);
  });

  it('forwards process close and invalidates closed entries', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const onClosed = vi.fn();
    const source = createAcpConnectionSource(sourceDeps(host, onClosed));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    host.lastHandle.emitExit(7);

    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledWith(key, 7));
    await source.invalidate(key);
    await waitForTeardown();
    expect(source.peek(key)).toBeUndefined();
  });

  it('disposes all active pooled processes', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const source = createAcpConnectionSource(sourceDeps(host));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    const acquired = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);
    expect(isOk(acquired)).toBe(true);
    await source.dispose();

    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(source.peek(key)).toBeUndefined();
  });

  it('returns spawn_failed when spawn resolution fails', async () => {
    const agent = new FakeAcpAgent();
    const host = new FakeAcpProcessHost();
    const agentHost = {
      buildAcpSpawn: vi
        .fn()
        .mockResolvedValue(
          err({ type: 'cli-not-found', providerId: 'claude', message: 'missing cli' })
        ),
    } as unknown as AgentPluginHost;
    const source = createAcpConnectionSource(sourceDeps(host, vi.fn(), agentHost));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    const result = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.type).toBe('spawn_failed');
    expect(result.error.cause?.message).toBe('missing cli');
    expect(host.allHandles).toHaveLength(0);
  });

  it('returns initialize_failed without notifying close when initialize fails', async () => {
    const agent = new FakeAcpAgent();
    agent.initialize = vi.fn().mockRejectedValue(new Error('init failed'));
    const host = new FakeAcpProcessHost();
    const onClosed = vi.fn();
    const source = createAcpConnectionSource(sourceDeps(host, onClosed));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    const result = await acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.type).toBe('initialize_failed');
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(source.peek(key)).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('shares a single failed in-flight initialization across concurrent acquires', async () => {
    const agent = new FakeAcpAgent();
    agent.initialize = vi.fn().mockRejectedValue(new Error('init failed'));
    const host = new FakeAcpProcessHost();
    const onClosed = vi.fn();
    const source = createAcpConnectionSource(sourceDeps(host, onClosed));
    const key = makeAcpConnectionKey('claude', 'ws-1');

    const [first, second] = await Promise.all([
      acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError),
      acquireAsResult(source, key, acquireInput(agent), isAcpConnectionError),
    ]);

    expect(isErr(first)).toBe(true);
    expect(isErr(second)).toBe(true);
    expect(host.allHandles).toHaveLength(1);
    expect(host.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
    expect(source.peek(key)).toBeUndefined();
    expect(onClosed).not.toHaveBeenCalled();
  });
});
