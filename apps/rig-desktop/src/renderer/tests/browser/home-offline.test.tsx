import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

/**
 * Home with the relay out of reach: the account's spaces still list from
 * this computer (never another account's), a banner says which kind of
 * trouble it is with a way to try again, relay actions are disabled with a
 * "Needs a connection" tooltip, and it all clears once the relay answers.
 */

type Result = { success: true; data: unknown } | { success: false; error: { kind: string; message: string } };
const fail: Result = { success: false, error: { kind: 'relay', message: 'unreachable' } };

const space = (id: string, name: string) => ({
  id,
  name,
  kind: 'space' as const,
  role: 'owner',
  lastSyncedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  relayHost: 'tap-relay.fly.dev',
});

const mocks = vi.hoisted(() => ({
  online: true,
  /** Nothing on this computer: no local rigs, no remembered spaces. */
  empty: false,
  /** No agent set up on this Mac. */
  noAgents: false,
  workspaces: vi.fn<() => Promise<unknown>>(),
  me: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      list: async () =>
        mocks.noAgents ? [] : [{ id: 'claude', name: 'Claude', icon: null, status: 'available', capabilities: { auth: { kind: 'none' } } }],
      listMetadata: async () => [],
    },
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      // Home's needs-sign-in line: nothing failed on its sign-in here.
      agentSignIn: { needed: async () => [] },
      account: { me: () => mocks.me(), workspaces: () => mocks.workspaces() },
      offline: {
        homeSnapshot: async () => ({
          accountId: 'u1',
          workspaces: mocks.empty ? null : {
            savedAt: 1,
            bindings: [space('s-local', 'design'), space('s-two', 'launch'), space('s-three', 'hiring')],
          },
          roomSavedAt: {},
        }),
      },
      recent: {
        recentRigs: async () => mocks.empty ? [] : [
          {
            bindingId: 's-local',
            name: 'design',
            path: '/Users/me/Rig/design',
            lastOpenedAt: Date.now() - 2 * 60 * 60 * 1000,
            paused: false,
            outsideHome: false,
            notARigAnymore: false,
            accountId: 'u1',
          },
          {
            bindingId: 's-theirs',
            name: 'someone-elses-space',
            path: '/Users/me/Rig/theirs',
            lastOpenedAt: Date.now(),
            paused: false,
            outsideHome: false,
            notARigAnymore: false,
            accountId: 'u2',
          },
        ],
        resolveLocalPaths: async () => ({}),
        backfillAccountId: async () => undefined,
      },
      sessions: { listRecentAcrossRigs: async () => [] },
      share: { listMyInvites: async () => fail, collaborators: async () => fail },
      spaceStatus: { get: async () => fail },
      spacesConnection: { listMembers: async () => fail },
      pulse: { get: async () => fail },
      settings: {
        get: async () => ({ spacesEnabled: true, rigsRailView: { filter: 'all', sort: 'recent' }, hiddenByRig: {} }),
        set: async () => {},
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { Home } from '@renderer/features/home/home';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => mocks.online });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('Home offline', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: Array<{ path: string; kind?: string }>;

  const banner = () => host.querySelector<HTMLElement>('[data-testid="connection-banner"]');
  const spaceNames = () =>
    [...host.querySelectorAll('[data-testid="space-row"]')].map((r) => r.querySelector('.truncate')?.textContent);
  const newSpace = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('New space'))!;
  const newRig = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'New')!;

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Home
            onOpenFolder={() => {}}
            onOpenPath={(path, opts) => opened.push({ path, kind: opts?.kind })}
            onContinueSession={() => {}}
            onRigCreated={() => {}}
          />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    mocks.online = true;
    mocks.empty = false;
    mocks.noAgents = false;
    mocks.me.mockReset().mockResolvedValue(fail);
    mocks.workspaces.mockReset().mockResolvedValue(fail);
    opened = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("lists this account's spaces from this computer when the relay is unreachable — never another account's", async () => {
    await mount();

    expect(banner()?.dataset.variant).toBe('unreachable');
    expect(banner()?.textContent).toContain("Can't reach rig right now · showing what's on this computer");
    expect(host.textContent).not.toContain('offline · team rigs unavailable');

    expect(new Set(spaceNames())).toEqual(new Set(['design', 'launch', 'hiring']));
    expect(host.textContent).not.toContain('someone-elses-space');
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="space-row"]')];
    expect(rows.every((r) => r.dataset.offline === 'true')).toBe(true);
    // Last activity from local data, not a live status.
    const design = rows.find((r) => r.textContent?.includes('design'))!;
    expect(design.querySelector('[data-testid="space-status-line"]')?.textContent).toBe('2h ago');

    // The local space opens (as a space) from this computer.
    await act(async () => (design.querySelector('button') as HTMLButtonElement).click());
    expect(opened).toEqual([{ path: '/Users/me/Rig/design', kind: 'space' }]);
  });

  it('disables relay actions with a "Needs a connection" tooltip', async () => {
    await mount();

    expect(newSpace().disabled).toBe(true);
    // Plain rigs are hidden while spaces are on: no Rigs card, no New rig.
    expect(newRig()).toBeFalsy();
    const wrapper = host.querySelector('[data-testid="new-space-cta"]')!.closest<HTMLElement>('[data-needs-connection]')!;
    expect(wrapper).not.toBeNull();
    await userEvent.hover(wrapper);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Needs a connection'));
  });

  it('says "offline" with no network, and clears once back online and the relay answers', async () => {
    mocks.online = false;
    await mount();
    expect(banner()?.dataset.variant).toBe('offline');
    expect(banner()?.textContent).toContain("You're offline · showing what's on this computer");

    mocks.me.mockResolvedValue({ success: true, data: { id: 'u1', clerkUserId: 'c', email: null, name: null, avatarUrl: null, createdAt: '' } });
    mocks.workspaces.mockResolvedValue({
      success: true,
      data: [space('s-local', 'design'), space('s-two', 'launch'), space('s-three', 'hiring')],
    });
    mocks.online = true;
    await act(async () => window.dispatchEvent(new Event('online')));
    await flush();

    expect(banner()).toBeNull();
    expect(newSpace().disabled).toBe(false);
    expect(host.querySelector('[data-offline]')).toBeNull();
    expect(new Set(spaceNames())).toEqual(new Set(['design', 'launch', 'hiring']));
  });

  it('first run offline: "Start fresh" is disabled with "Needs a connection"', async () => {
    mocks.empty = true;
    mocks.online = false;
    await mount();
    const startFresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Start fresh'
    )!;
    expect(startFresh.disabled).toBe(true);
    expect(startFresh.closest('[data-needs-connection]')).not.toBeNull();
  });

  it('"Try again" re-asks the relay, quietly reconnecting meanwhile', async () => {
    await mount();
    const calls = mocks.workspaces.mock.calls.length;
    let answer: (value: unknown) => void = () => {};
    mocks.workspaces.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    const tryAgain = [...banner()!.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    await act(async () => tryAgain.click());
    expect(mocks.workspaces.mock.calls.length).toBe(calls + 1);
    expect(banner()?.textContent).toContain('Reconnecting…');

    await act(async () => answer({ success: true, data: [space('s-local', 'design')] }));
    await flush();
    expect(banner()).toBeNull();
  });

  it('slow is not offline: a long first load shows a quiet hint and the remembered spaces, nothing disabled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.workspaces.mockImplementation(() => new Promise(() => {}));
      mocks.me.mockImplementation(() => new Promise(() => {}));
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <Home onOpenFolder={() => {}} onOpenPath={() => {}} onContinueSession={() => {}} onRigCreated={() => {}} />
          </QueryClientProvider>
        );
      });
      for (let i = 0; i < 5; i++) await act(async () => vi.advanceTimersByTime(1));
      expect(banner()).toBeNull();
      expect(new Set(spaceNames())).toEqual(new Set(['design', 'launch', 'hiring']));

      await act(async () => vi.advanceTimersByTime(5_000));
      expect(banner()?.dataset.variant).toBe('slow');
      expect(banner()?.textContent).toContain('Still connecting to rig…');
      expect(banner()?.textContent).not.toContain('Try again');
      expect(newSpace().disabled).toBe(false);
      expect(host.querySelector('[data-offline]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no agent set up, says so and offers Set up an agent, on the full Home and the first-run one', async () => {
    mocks.noAgents = true;
    await mount();
    const line = host.querySelector<HTMLElement>('[data-testid="home-no-agent"]');
    expect(line?.textContent).toContain('No agent is set up on this Mac yet.');
    await act(async () => line!.querySelector<HTMLButtonElement>('[data-testid="home-set-up-agent"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-setup-dialog"]')).not.toBeNull());
    await act(async () => root.unmount());

    root = createRoot(host);
    mocks.empty = true;
    await mount();
    expect(host.querySelector('[data-testid="home-set-up-agent"]')).not.toBeNull();
  });
});
