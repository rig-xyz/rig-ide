import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Welcome's Start fresh on the spaces path: a failure says why under the
 * button and leaves it clickable to try again.
 */

const ok = (data: unknown) => ({ success: true as const, data });

const mocks = vi.hoisted(() => ({
  start: vi.fn<(input: { name: string }) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      list: async () => [
        { id: 'claude', name: 'Claude', icon: null, status: 'available', version: '2.1.160', installations: [], used: { kind: 'auto' }, latestVersion: null, capabilities: { auth: { kind: 'none' } } },
      ],
      probeAll: async () => undefined,
      listMetadata: async () => [],
    },
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      agentSignIn: { needed: async () => [] },
      account: {
        me: async () => ok({ id: 'u1', email: 'me@example.com', name: 'Me' }),
        workspaces: async () => ok([]),
      },
      offline: { homeSnapshot: async () => ({ accountId: 'u1', workspaces: null, roomSavedAt: {} }) },
      recent: { recentRigs: async () => [], resolveLocalPaths: async () => ({}), backfillAccountId: async () => undefined },
      sessions: { listRecentAcrossRigs: async () => [] },
      share: { listMyInvites: async () => ok({ invites: [] }), collaborators: async () => ok([]) },
      spaceStatus: { get: async () => ok([]) },
      spaceSetup: { start: (input: { name: string }) => mocks.start(input), list: async () => [] },
      pulse: { get: async () => ({ success: false, error: { kind: 'relay', message: 'off' } }) },
      settings: {
        get: async () => ({ spacesEnabled: true, showPlainRigs: false, rigsRailView: { filter: 'all', sort: 'recent' }, hiddenByRig: {} }),
        set: async () => {},
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { Home } from '@renderer/features/home/home';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('Welcome Start fresh', () => {
  let host: HTMLDivElement;
  let root: Root;

  const startFresh = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button.welcome-cta')].find((b) =>
      /Start fresh|Starting/.test(b.textContent ?? '')
    )!;

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Home onOpenFolder={() => {}} onOpenPath={() => {}} onContinueSession={() => {}} onRigCreated={() => {}} />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    mocks.start.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('shows why when the space could not be started, and can be tried again', async () => {
    mocks.start.mockResolvedValue({
      success: false,
      error: { kind: 'initFailed', message: "Rig couldn't make its folder in your home folder." },
    });
    await mount();
    await act(async () => startFresh().click());
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Rig couldn't make its folder in your home folder.");
    expect(startFresh().disabled).toBe(false);
  });

  it('says so when starting throws', async () => {
    mocks.start.mockRejectedValue(new Error('ipc closed'));
    await mount();
    await act(async () => startFresh().click());
    await flush();
    expect(host.textContent).toContain("Rig couldn't start your space. Try again.");
    expect(host.textContent).not.toContain('ipc closed');
  });
});
