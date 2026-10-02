import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RoomThemeRequestModule from '@renderer/features/spaces/room-theme-request';
import type { RigRecentTheme, RigRecentThemes } from '@shared/rig/recent-themes';

/**
 * "Many spaces on Home" v2: "Across your spaces today" under the Ask box,
 * built from the relay's Room themes of the last 24h. One card per theme,
 * newest first, five then "N more topics"; a card opens its space's Room,
 * on that theme when Room themes is on; a quiet day says so. The same read
 * leads each Spaces row's status line with the space's busiest theme.
 */

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function theme(i: number, over: Partial<RigRecentTheme> = {}): RigRecentTheme {
  return {
    themeId: `thm_${i}`,
    bindingId: 's-launch',
    spaceName: 'launch',
    name: `Topic ${i}`,
    description: `What topic ${i} is about`,
    messageCount: 1,
    people: ['Hugo'],
    lastActivityAt: iso(i * 10),
    lastSeq: 100 - i,
    ...over,
  };
}

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
  live: { kind: 'none' } as RigRecentThemes,
  cached: { kind: 'none' } as RigRecentThemes,
  roomThemesEnabled: true,
  getCalls: 0,
  requests: [] as Array<[string, string]>,
}));

const fail = { success: false, error: { kind: 'relay', message: 'nope' } };

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      list: async () => [{ id: 'claude', name: 'Claude', icon: null, status: 'available' }],
      listMetadata: async () => [],
    },
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      account: {
        me: async () => ({
          success: true,
          data: {
            id: 'u1',
            clerkUserId: 'c1',
            email: 'dylan@x.co',
            name: 'Dylan',
            avatarUrl: null,
            createdAt: '',
          },
        }),
        workspaces: async () => ({
          success: true,
          data: [
            space('s-launch', 'launch'),
            space('s-pricing', 'pricing'),
            space('s-remote', 'remote'),
          ],
        }),
      },
      offline: {
        homeSnapshot: async () => ({ accountId: 'u1', workspaces: null, roomSavedAt: {} }),
      },
      recent: {
        recentRigs: async () => [
          {
            bindingId: 's-launch',
            name: 'launch',
            path: '/Users/me/Rig/launch',
            lastOpenedAt: NOW - 60_000,
            paused: false,
            outsideHome: false,
            notARigAnymore: false,
            accountId: 'u1',
          },
          {
            bindingId: 's-pricing',
            name: 'pricing',
            path: '/Users/me/Rig/pricing',
            lastOpenedAt: NOW - 120_000,
            paused: false,
            outsideHome: false,
            notARigAnymore: false,
            accountId: 'u1',
          },
        ],
        resolveLocalPaths: async () => ({}),
        backfillAccountId: async () => undefined,
      },
      recentThemes: {
        get: async () => {
          mocks.getCalls += 1;
          return mocks.live;
        },
        cached: async () => mocks.cached,
      },
      sessions: { listRecentAcrossRigs: async () => [] },
      share: { listMyInvites: async () => fail, collaborators: async () => fail },
      spaceStatus: { get: async () => ({ success: true, data: [] }) },
      spacesConnection: {
        listMembers: async () => ({ success: true, data: [] }),
        listConnectors: async () => ({ success: true, data: [] }),
      },
      connectors: { list: async () => [] },
      pulse: { get: async () => fail },
      syncHealth: {
        get: async ({ paths }: { paths: string[] }) =>
          Object.fromEntries(paths.map((p) => [p, { state: 'running' }])),
      },
      homeLayout: { get: async () => null, apply: async () => null },
      notifications: {
        summary: async () => ({ spaces: [], invitesUnread: 0, directUnreadTotal: 0 }),
        activity: async () => ({ notifications: [], nextCursor: null }),
        permission: async () => 'granted',
      },
      settings: {
        get: async () => ({
          spacesEnabled: true,
          roomThemesEnabled: mocks.roomThemesEnabled,
          rigsRailView: { filter: 'all', sort: 'recent' },
          hiddenByRig: {},
        }),
        set: async () => {},
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

vi.mock('@renderer/features/spaces/room-theme-request', async (importOriginal) => ({
  ...(await importOriginal<typeof RoomThemeRequestModule>()),
  requestRoomTheme: (bindingId: string, themeId: string) =>
    mocks.requests.push([bindingId, themeId]),
}));

import { Home } from '@renderer/features/home/home';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('Home: Across your spaces today', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: Array<{ path: string; kind?: string }>;

  const section = () => host.querySelector<HTMLElement>('[data-testid="across-spaces-today"]');
  const cards = () => [...host.querySelectorAll<HTMLElement>('[data-testid="theme-card"]')];
  const cardIds = () => cards().map((c) => c.dataset.themeId);
  const rowLine = (bindingId: string) =>
    host
      .querySelector(`[data-testid="space-row"][data-binding-id="${bindingId}"]`)
      ?.querySelector<HTMLElement>('[data-testid="space-status-line"]');

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
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
    localStorage.clear();
    mocks.live = { kind: 'none' };
    mocks.cached = { kind: 'none' };
    mocks.roomThemesEnabled = true;
    mocks.getCalls = 0;
    mocks.requests = [];
    opened = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('shows one card per theme, newest first, five then "N more topics"', async () => {
    const themes = [3, 0, 6, 1, 5, 2, 4].map((i) => theme(i));
    mocks.live = { kind: 'live', themes, savedAt: NOW };
    await mount();

    expect(section()?.querySelector('h2')?.textContent).toBe('Across your spaces today');
    expect(cardIds()).toEqual(['thm_0', 'thm_1', 'thm_2', 'thm_3', 'thm_4']);
    const more = host.querySelector<HTMLButtonElement>('[data-testid="across-spaces-more"]')!;
    expect(more.textContent).toBe('2 more topics');
    await act(async () => more.click());
    expect(cardIds()).toEqual(['thm_0', 'thm_1', 'thm_2', 'thm_3', 'thm_4', 'thm_5', 'thm_6']);
    // One read for the whole Home, not one per row.
    expect(mocks.getCalls).toBe(1);
  });

  it('a card: the theme in bold, its space, its line, and who wrote what', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, {
          name: 'Bugs & Wishlist',
          description: 'Things to fix before launch',
          messageCount: 5,
          people: ['Hugo', "Hugo's Claude"],
        }),
      ],
    };
    await mount();
    const card = cards()[0]!;
    const name = [...card.querySelectorAll('span')].find(
      (s) => s.textContent === 'Bugs & Wishlist'
    )!;
    expect(name.className).toContain('font-medium');
    expect(card.querySelector('[data-testid="theme-card-space"]')?.textContent).toBe('# launch');
    expect(card.textContent).toContain('Things to fix before launch');
    expect(card.textContent).toContain("5 new messages · Hugo, Hugo's Claude");
  });

  it('clicking a card opens its Room on that theme when Room themes is on', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [theme(1, { bindingId: 's-pricing', spaceName: 'pricing' })],
    };
    await mount();
    await act(async () => cards()[0]!.click());
    expect(opened).toEqual([{ path: '/Users/me/Rig/pricing', kind: 'space' }]);
    expect(mocks.requests).toEqual([['s-pricing', 'thm_1']]);
  });

  it('with Room themes off, a card just opens the Room', async () => {
    mocks.roomThemesEnabled = false;
    mocks.live = { kind: 'live', savedAt: NOW, themes: [theme(1)] };
    await mount();
    await act(async () => cards()[0]!.click());
    expect(opened).toEqual([{ path: '/Users/me/Rig/launch', kind: 'space' }]);
    expect(mocks.requests).toEqual([]);
  });

  it('a space with no folder here is flashed in the Spaces card, not opened', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [theme(1, { bindingId: 's-remote', spaceName: 'remote' })],
    };
    await mount();
    await act(async () => cards()[0]!.click());
    expect(opened).toEqual([]);
    expect(mocks.requests).toEqual([]);
  });

  it('says "Quiet day across your spaces" when nothing happened', async () => {
    mocks.live = { kind: 'live', savedAt: NOW, themes: [] };
    await mount();
    expect(host.querySelector('[data-testid="across-spaces-empty"]')?.textContent).toBe(
      'Quiet day across your spaces'
    );
    expect(cards()).toHaveLength(0);
  });

  it("shows this account's last topics from this computer when the relay can't answer", async () => {
    mocks.live = { kind: 'cached', savedAt: NOW - 3_600_000, themes: [theme(2)] };
    await mount();
    expect(cardIds()).toEqual(['thm_2']);
  });

  it('drops the pulse summary: no "updated" line, the Ask box and its chips stay', async () => {
    mocks.live = { kind: 'live', savedAt: NOW, themes: [] };
    await mount();
    expect(host.textContent).not.toMatch(/updated .* ago/);
    expect(host.querySelector('input[placeholder="Ask across your spaces…"]')).not.toBeNull();
    expect(host.textContent).toContain("What's blocked?");
  });

  it("leads each row's status line with its busiest theme of the day, and clicking the row opens on it", async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, { name: 'Small talk', messageCount: 2 }),
        theme(2, { name: 'Bugs & Wishlist', messageCount: 5 }),
      ],
    };
    await mount();
    expect(rowLine('s-launch')?.textContent).toMatch(/^Bugs & Wishlist/);
    expect(rowLine('s-pricing')?.textContent).not.toContain('Bugs');
    const name = host.querySelector<HTMLButtonElement>(
      '[data-testid="space-row"][data-binding-id="s-launch"] [data-testid="space-row-name"]'
    )!;
    await act(async () => name.click());
    expect(opened).toEqual([{ path: '/Users/me/Rig/launch', kind: 'space' }]);
    expect(mocks.requests).toEqual([['s-launch', 'thm_2']]);
  });
});
