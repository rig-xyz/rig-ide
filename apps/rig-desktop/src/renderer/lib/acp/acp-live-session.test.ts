import type * as WireModule from '@emdash/wire';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
}));

vi.mock('./runtime-client', () => ({
  getAcpRuntimeClient: mocks.getClient,
}));

vi.mock('@emdash/wire/util/mobx', () => ({
  createImmutableMobxStore: () => ({}),
  createMobxLogStore: () => ({}),
}));

vi.mock('@emdash/wire', async (importOriginal) => {
  const actual = await importOriginal<typeof WireModule>();
  return {
    ...actual,
    ReplicaLog: class {},
    ReplicaState: class {
      readonly ready: Promise<void>;
      private disposed = false;

      constructor(private readonly handle: FakeHandle) {
        this.ready = handle.ready;
      }

      current(): unknown {
        return undefined;
      }

      onChange(): () => void {
        return () => undefined;
      }

      async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.handle.disposeCount += 1;
      }
    },
  };
});

import { AcpLiveSession } from './acp-live-session';

type FakeHandle = {
  ready: Promise<void>;
  disposeCount: number;
};

type StartupControl = {
  ready: Promise<void>;
  handles: FakeHandle[];
};

const input = {
  conversationId: 'conversation',
  projectId: 'project',
  taskId: 'task',
  providerId: 'codex',
  workspaceId: 'workspace',
  cwd: '/tmp/workspace',
  sessionId: null,
  model: null,
};

let controls: StartupControl[];
let activeControl: StartupControl | undefined;
let client: ReturnType<typeof makeClient>;

function makeControl(ready: Promise<void>): StartupControl {
  return { ready, handles: [] };
}

function makeClient() {
  const startSession = vi.fn(async () => {
    activeControl = controls.shift();
    return { success: true as const, data: { sessionId: 'acp-session' } };
  });
  const resumeSession = vi.fn(async () => {
    activeControl = controls.shift();
    return {
      success: true as const,
      data: { turns: [], nextCursor: undefined },
    };
  });
  const stopSession = vi.fn(async () => ({ success: true as const, data: undefined }));
  return {
    startSession,
    resumeSession,
    stopSession,
    session: {
      state: vi.fn(() => {
        const handle: FakeHandle = {
          ready: activeControl?.ready ?? Promise.resolve(),
          disposeCount: 0,
        };
        activeControl?.handles.push(handle);
        return handle;
      }),
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('AcpLiveSession startup lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
    controls = [];
    activeControl = undefined;
    client = makeClient();
    mocks.getClient.mockResolvedValue(client);
  });

  it('stops the runtime and disposes every replica when readiness rejects', async () => {
    const control = makeControl(Promise.reject(new Error('replica failed')));
    controls.push(control);

    await expect(AcpLiveSession.create('readiness-rejection', input)).rejects.toThrow(
      'replica failed'
    );
    await flush();

    expect(client.stopSession).toHaveBeenCalledTimes(1);
    expect(control.handles).toHaveLength(7);
    expect(control.handles.every((handle) => handle.disposeCount === 1)).toBe(true);
  });

  it('stops the runtime and disposes every replica when readiness times out', async () => {
    const control = makeControl(new Promise<void>(() => undefined));
    controls.push(control);

    const startup = AcpLiveSession.create('readiness-timeout', input);
    const rejection = expect(startup).rejects.toThrow('Timed out connecting ACP live models');
    await flush();
    await vi.advanceTimersByTimeAsync(10_001);

    await rejection;
    expect(client.stopSession).toHaveBeenCalledTimes(1);
    expect(control.handles).toHaveLength(7);
    expect(control.handles.every((handle) => handle.disposeCount === 1)).toBe(true);
  });

  it('cleans up a late successful start after its RPC timeout', async () => {
    let resolveStart!: (value: unknown) => void;
    const startResult = new Promise((resolve) => {
      resolveStart = resolve;
    });
    client.startSession.mockReturnValueOnce(startResult as never);

    const startup = AcpLiveSession.create('late-start', input);
    const rejection = expect(startup).rejects.toThrow('Timed out starting ACP session');
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;

    resolveStart({ success: true, data: { sessionId: 'late-session' } });
    await flush();
    expect(client.stopSession).toHaveBeenCalledTimes(1);
  });

  it('waits for late timeout cleanup before starting a different queued operation', async () => {
    let resolveStart!: (value: unknown) => void;
    const lateStart = new Promise((resolve) => {
      resolveStart = resolve;
    });
    client.startSession.mockReturnValueOnce(lateStart as never);

    let resolveStop!: (value: unknown) => void;
    const pendingStop = new Promise((resolve) => {
      resolveStop = resolve;
    });
    client.stopSession.mockReturnValueOnce(pendingStop as never);

    const first = AcpLiveSession.create('queued-cleanup', input);
    const firstRejection = expect(first).rejects.toThrow('Timed out starting ACP session');
    await vi.advanceTimersByTimeAsync(10_001);
    await firstRejection;

    const retryControl = makeControl(Promise.resolve());
    controls.push(retryControl);
    const queued = AcpLiveSession.create('queued-cleanup', { ...input, model: 'other-model' });
    await flush();
    expect(client.startSession).toHaveBeenCalledTimes(1);

    resolveStart({ success: true, data: { sessionId: 'late-session' } });
    await flush();
    expect(client.stopSession).toHaveBeenCalledTimes(1);
    expect(client.startSession).toHaveBeenCalledTimes(1);

    resolveStop({ success: true, data: undefined });
    const session = await queued;
    expect(client.startSession).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('deduplicates concurrent starts and allows a clean retry after failure', async () => {
    controls.push(makeControl(Promise.reject(new Error('first attempt failed'))));
    const first = AcpLiveSession.create('retry', input);
    const duplicate = AcpLiveSession.create('retry', { ...input });

    const results = await Promise.allSettled([first, duplicate]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results[0]).toMatchObject({ reason: expect.any(Error) });
    await flush();
    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(client.stopSession).toHaveBeenCalledTimes(1);

    const retryControl = makeControl(Promise.resolve());
    controls.push(retryControl);
    const session = await AcpLiveSession.create('retry', input);
    expect(client.startSession).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('cleans up a resumed session when live models reject', async () => {
    const control = makeControl(Promise.reject(new Error('resume replica failed')));
    controls.push(control);

    await expect(
      AcpLiveSession.resume('resume-failure', { ...input, sessionId: 'acp-session' })
    ).rejects.toThrow('resume replica failed');
    await flush();

    expect(client.resumeSession).toHaveBeenCalledTimes(1);
    expect(client.stopSession).toHaveBeenCalledTimes(1);
    expect(control.handles.every((handle) => handle.disposeCount === 1)).toBe(true);
  });

  it('returns a ready session without stopping it on success', async () => {
    const control = makeControl(Promise.resolve());
    controls.push(control);

    const session = await AcpLiveSession.create('success', input);
    expect(session.acpSessionId).toBe('acp-session');
    expect(client.stopSession).not.toHaveBeenCalled();
    session.dispose();
  });
});
