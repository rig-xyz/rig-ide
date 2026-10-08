import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RoomThemeRequestModule from '@renderer/features/spaces/room-theme-request';
import type { RigRecentTheme, RigRecentThemes } from '@shared/rig/recent-themes';

/**
 * "Many spaces on Home" v2: "Across your spaces today" under the Ask box,
 * built from the relay's Room themes of the last 24h. A flat feed, one line
 * per theme, newest first, five then "N more topics"; a line opens in place
 * to its description, one at a time, and from there (or its space name)
 * opens its space's Room, on that theme when Room themes is on; a quiet day
 * says so. People sits under it in the same center column, with no right
 * column. The same read leads each Spaces row's status line with the
 * space's busiest theme.
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
  pulse: null as unknown,
  summary: null as unknown,
  activity: [] as unknown[],
}));

/** An unread mention of you in a space, as the Activity rows carry it. */
function mention(bindingId: string, userId: string, name: string) {
  return {
    id: `n-${bindingId}-${userId}`,
    type: 'mention',
    tier: 'direct',
    bindingId,
    spaceName: 'launch',
    actor: { kind: 'user', userId, name, agent: null },
    messageId: 'm1',
    messageSeq: 90,
    runId: null,
    requestId: null,
    inviteId: null,
    path: null,
    title: `${name} mentioned you in launch`,
    body: '@Dylan wdyt',
    createdAt: new Date(NOW).toISOString(),
    readAt: null,
  };
}

const fail = { success: false, error: { kind: 'relay', message: 'nope' } };

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      list: async () => [
        { id: 'claude', name: 'Claude', icon: null, status: 'available', version: null, installations: [], used: { kind: 'auto' }, latestVersion: null, capabilities: { auth: { kind: 'none' } } },
      ],
      listMetadata: async () => [],
    },
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      // Home's needs-sign-in line: nothing failed on its sign-in here.
      agentSignIn: { needed: async () => [] },
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
        listMessages: async () => ({ success: true, data: [] }),
      },
      spacesDispatch: { localRunEvents: async () => ({ events: null }) },
      pulse: { get: async () => mocks.pulse ?? fail },
      syncHealth: {
        get: async ({ paths }: { paths: string[] }) =>
          Object.fromEntries(paths.map((p) => [p, { state: 'running' }])),
      },
      homeLayout: { get: async () => null, apply: async () => null },
      notifications: {
        summary: async () => mocks.summary ?? { spaces: [], invitesUnread: 0, directUnreadTotal: 0 },
        activity: async () => ({ success: true, data: mocks.activity }),
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
  const lines = () => [...host.querySelectorAll<HTMLElement>('[data-testid="theme-line"]')];
  const lineIds = () => lines().map((c) => c.dataset.themeId);
  const openIds = () =>
    lines()
      .filter((l) => l.dataset.open === 'true')
      .map((l) => l.dataset.themeId);
  const toggle = (line: HTMLElement) =>
    line.querySelector<HTMLButtonElement>('[data-testid="theme-line-name"]')!;
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
    mocks.pulse = null;
    mocks.summary = null;
    mocks.activity = [];
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

  it('shows one line per theme, newest first, five then "N more topics"', async () => {
    const themes = [3, 0, 6, 1, 5, 2, 4].map((i) => theme(i));
    mocks.live = { kind: 'live', themes, savedAt: NOW };
    await mount();

    const label = section()?.querySelector('h2');
    expect(label?.textContent).toBe('Across your spaces today7 topics');
    expect(label?.className).toContain('uppercase');
    expect(label?.className).toContain('font-mono');
    expect(lineIds()).toEqual(['thm_0', 'thm_1', 'thm_2', 'thm_3', 'thm_4']);
    const more = host.querySelector<HTMLButtonElement>('[data-testid="across-spaces-more"]')!;
    expect(more.textContent).toBe('2 more topics');
    await act(async () => more.click());
    expect(lineIds()).toEqual(['thm_0', 'thm_1', 'thm_2', 'thm_3', 'thm_4', 'thm_5', 'thm_6']);
    // One read for the whole Home, not one per row.
    expect(mocks.getCalls).toBe(1);
  });

  it('a line: color dot, the theme in bold, its space, faces only for who is a reason (agents as their owner), and its age', async () => {
    mocks.activity = [mention('s-launch', 'u-hugo', 'Hugo Renaudin')];
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, {
          name: 'Bugs & Wishlist',
          description: 'Things to fix before launch',
          messageCount: 5,
          people: ["Hugo's Claude", 'Hugo', 'Ana'],
          lastActivityAt: iso(4),
        }),
      ],
    };
    await mount();
    const line = lines()[0]!;
    // No card around it.
    expect(line.className).not.toMatch(/\bborder\b|shadow/);
    expect(section()?.querySelector('.rounded-card')).toBeNull();
    const name = line.querySelector<HTMLElement>('[data-testid="theme-line-name"]')!;
    expect(name.textContent).toBe('Bugs & Wishlist');
    expect(name.className).toContain('font-semibold');
    expect(name.className).toContain('truncate');
    expect(line.querySelector('[data-testid="theme-line-space"]')?.textContent).toBe('# launch');
    const dot = line.querySelector<HTMLElement>('span[aria-hidden]')!;
    expect(dot.style.background).toMatch(/^var\(--theme-[1-8]\)$/);
    expect(dot.style.boxShadow).toContain('color-mix');
    // Hugo mentioned you there; Ana wrote in the topic but isn't a reason, so no face.
    const faces = line.querySelector('[data-testid="theme-line-faces"]')!;
    expect([...faces.children].map((f) => f.getAttribute('title'))).toEqual(['Hugo Renaudin mentioned you']);
    expect(line.querySelector('[data-testid="theme-line-age"]')?.textContent).toBe('4m');
    // Its description is always there as a one line summary under it; the activity waits until it's opened.
    const desc = line.querySelector<HTMLElement>('[data-testid="theme-line-desc"]')!;
    expect(desc.textContent).toBe('Things to fix before launch');
    expect(desc.className).toContain('truncate');
    expect(desc.className).toContain('text-text-secondary');
    expect(line.querySelector('[data-testid="theme-line-detail"]')).toBeNull();
  });

  it('no faces on a line when no one in it is a reason', async () => {
    mocks.live = { kind: 'live', savedAt: NOW, themes: [theme(1, { people: ['Hugo', 'Ana'] })] };
    await mount();
    expect(lines()[0]!.querySelector('[data-testid="theme-line-faces"]')).toBeNull();
  });

  it('every line carries its summary, and a line without a description has none', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [theme(1), theme(2), theme(3, { description: '' })],
    };
    await mount();
    expect(
      lines().map((l) => l.querySelector('[data-testid="theme-line-desc"]')?.textContent ?? null)
    ).toEqual(['What topic 1 is about', 'What topic 2 is about', null]);
  });

  it('a line opens in place to its description, one line open at a time', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, {
          description: 'Things to fix',
          messageCount: 5,
          people: ['Hugo', "Hugo's Claude"],
        }),
        theme(2),
      ],
    };
    await mount();
    await act(async () => toggle(lines()[0]!).click());
    expect(openIds()).toEqual(['thm_1']);
    expect(toggle(lines()[0]!).getAttribute('aria-expanded')).toBe('true');
    // Open, the summary wraps in full, and the activity line follows it.
    const desc = lines()[0]!.querySelector<HTMLElement>('[data-testid="theme-line-desc"]')!;
    expect(desc.textContent).toBe('Things to fix');
    expect(desc.className).not.toContain('truncate');
    const detail = lines()[0]!.querySelector('[data-testid="theme-line-detail"]')!;
    expect(detail.textContent).toBe(
      "5 new messages · Hugo, Hugo's Claude · Open the space on this topic ›"
    );
    expect(desc.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The other line keeps its summary cut to one line.
    expect(lines()[1]!.querySelector('[data-testid="theme-line-desc"]')!.className).toContain(
      'truncate'
    );
    // Opening it opens nothing yet.
    expect(opened).toEqual([]);

    // Clicking anywhere on another line opens it and closes the first.
    await act(async () =>
      lines()[1]!.querySelector<HTMLElement>('[data-testid="theme-line-age"]')!.click()
    );
    expect(openIds()).toEqual(['thm_2']);
    await act(async () => toggle(lines()[1]!).click());
    expect(openIds()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('"Open the space on this topic" opens its Room on that theme when Room themes is on', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [theme(1, { bindingId: 's-pricing', spaceName: 'pricing' })],
    };
    await mount();
    await act(async () => toggle(lines()[0]!).click());
    await act(async () =>
      lines()[0]!.querySelector<HTMLButtonElement>('[data-testid="theme-line-open"]')!.click()
    );
    expect(opened).toEqual([{ path: '/Users/me/Rig/pricing', kind: 'space' }]);
    expect(mocks.requests).toEqual([['s-pricing', 'thm_1']]);
  });

  it('the space name opens its Room on that theme too, without opening the line', async () => {
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [theme(1, { bindingId: 's-pricing', spaceName: 'pricing' })],
    };
    await mount();
    await act(async () =>
      lines()[0]!.querySelector<HTMLButtonElement>('[data-testid="theme-line-space"]')!.click()
    );
    expect(opened).toEqual([{ path: '/Users/me/Rig/pricing', kind: 'space' }]);
    expect(mocks.requests).toEqual([['s-pricing', 'thm_1']]);
    expect(openIds()).toEqual([]);
  });

  it('with Room themes off, it just opens the Room', async () => {
    mocks.roomThemesEnabled = false;
    mocks.live = { kind: 'live', savedAt: NOW, themes: [theme(1)] };
    await mount();
    await act(async () =>
      lines()[0]!.querySelector<HTMLButtonElement>('[data-testid="theme-line-space"]')!.click()
    );
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
    await act(async () => toggle(lines()[0]!).click());
    await act(async () =>
      lines()[0]!.querySelector<HTMLButtonElement>('[data-testid="theme-line-open"]')!.click()
    );
    expect(opened).toEqual([]);
    expect(mocks.requests).toEqual([]);
  });

  it('People: You first, a time, the Pulse sentence; under the topics, and a column on the right on wide windows', async () => {
    mocks.activity = [mention('s-launch', 'u2', 'Ana Silva')];
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, { people: ["Ana's Claude"], lastActivityAt: iso(12) }),
        theme(2, { people: ['Ana'], lastActivityAt: iso(90) }),
      ],
    };
    mocks.pulse = {
      success: true,
      data: {
        cached: false,
        briefing: {
          greeting: '',
          summary: '',
          pickBackUp: [],
          perRig: [],
          perPerson: [
            {
              userId: 'u2',
              name: 'Ana Silva',
              avatarUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
              line: 'Ana shipped the pricing page.',
              isSelf: false,
            },
            {
              userId: 'u1',
              name: 'Dylan',
              avatarUrl: null,
              line: 'You reviewed the launch plan.',
              isSelf: true,
            },
          ],
          generatedAt: new Date(NOW).toISOString(),
          degraded: false,
        },
      },
    };
    await mount();
    const center = host.querySelector<HTMLElement>('[data-testid="home-center"]')!;
    const people = center.querySelector<HTMLElement>('[data-testid="home-people"]')!;
    expect(people).not.toBeNull();
    expect(people.querySelector('h2')?.textContent).toBe('People');
    // Below the topics.
    expect(
      section()!.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const rows = [...people.querySelectorAll<HTMLElement>('[data-testid="home-person"]')];
    expect(
      rows.map((r) => r.querySelector('[data-testid="home-person-name"]')?.textContent)
    ).toEqual(['You', 'Ana Silva']);
    expect(rows[1]!.textContent).toContain('Ana shipped the pricing page.');
    // Ana's last word today, her agent's included; no time for someone the themes don't name.
    expect(rows[1]!.querySelector('[data-testid="home-person-age"]')?.textContent).toBe('12m');
    expect(rows[0]!.querySelector('[data-testid="home-person-age"]')).toBeNull();
    // No pills, no card.
    expect(people.querySelector('.rounded-card, .rounded-chip')).toBeNull();
    // Her face on the topic line is her Pulse picture.
    expect(lines()[0]!.querySelector('[data-testid="theme-line-faces"] img')).not.toBeNull();
    // Under the topics only below 1400px; from there it's the column on the right.
    expect(people.className).toContain('min-[87.5rem]:hidden');
    const columns = [...center.parentElement!.children];
    expect(columns).toHaveLength(3);
    const box = columns.find((c) => c !== center && c.matches('[data-testid="home-people"]'))!;
    expect(box).toBeDefined();
    expect(box.className).toContain('min-[87.5rem]:flex');
    // Plain: no outline, no fill.
    expect(box.className).not.toMatch(/\bborder\b|\bbg-/);
  });

  it('marks topics past the read cursor with "N new" and their summary; the read ones step back', async () => {
    mocks.summary = {
      spaces: [
        {
          bindingId: 's-launch',
          name: 'launch',
          latestDirect: null,
          level: 'all',
          lastReadSeq: 96,
          spaceUnread: 25,
          directUnread: 0,
          directUnreadNoMessage: 0,
        },
      ],
      invitesUnread: 0,
      directUnreadTotal: 0,
    };
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, { name: 'Onboarding Strategy', messageCount: 40, lastSeq: 99 }),
        theme(2, { name: 'Space Rename', lastSeq: 96 }),
        theme(3, { bindingId: 's-pricing', spaceName: 'pricing', lastSeq: 500 }),
      ],
    };
    await mount();
    const [fresh, read, unknown] = lines();
    expect(fresh!.dataset.mark).toBe('new');
    expect(fresh!.querySelector('[data-testid="theme-line-new"]')?.textContent).toBe('25 new');
    expect(fresh!.querySelector('[data-testid="theme-line-desc"]')?.textContent).toBe('What topic 1 is about');
    expect(fresh!.className).not.toContain('opacity-50');

    expect(read!.dataset.mark).toBe('seen');
    expect(read!.className).toContain('opacity-50');
    expect(read!.querySelector('[data-testid="theme-line-new"]')).toBeNull();
    expect(read!.querySelector('[data-testid="theme-line-desc"]')).toBeNull();
    expect(read!.querySelector('[data-testid="theme-line-name"]')!.className).toContain('font-medium');
    // Opened, a read topic comes back to full strength with its summary.
    await act(async () => toggle(read!).click());
    expect(lines()[1]!.className).not.toContain('opacity-50');
    expect(lines()[1]!.querySelector('[data-testid="theme-line-desc"]')).not.toBeNull();

    // A space whose cursor isn't known: unmarked, as before.
    expect(unknown!.dataset.mark).toBeUndefined();
    expect(unknown!.className).not.toContain('opacity-50');
  });

  it("Ask's chips come from the screen: the busiest space, who mentioned you on their topic, a new topic", async () => {
    mocks.summary = {
      spaces: [
        {
          bindingId: 's-launch',
          name: 'launch',
          latestDirect: null,
          level: 'all',
          lastReadSeq: 90,
          spaceUnread: 25,
          directUnread: 1,
          directUnreadNoMessage: 0,
        },
      ],
      invitesUnread: 0,
      directUnreadTotal: 1,
    };
    mocks.activity = [mention('s-launch', 'u-hugo', 'Hugo Renaudin')];
    mocks.live = {
      kind: 'live',
      savedAt: NOW,
      themes: [
        theme(1, { name: 'Onboarding Strategy', people: ['Hugo'], lastSeq: 99 }),
        theme(2, { name: 'Pricing page', people: ['Ana'], lastSeq: 98 }),
      ],
    };
    await mount();
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="ask-chip"]')].map((c) => c.textContent);
    expect(chips).toEqual([
      'Catch me up on launch25 new',
      'What did Hugo decide on Onboarding Strategy?mentioned you',
      "What's left on Pricing page?#launch",
    ]);
    expect(host.textContent).not.toContain("What's blocked?");
  });

  it('says "Quiet day across your spaces" when nothing happened', async () => {
    mocks.live = { kind: 'live', savedAt: NOW, themes: [] };
    await mount();
    expect(host.querySelector('[data-testid="across-spaces-empty"]')?.textContent).toBe(
      'Quiet day across your spaces'
    );
    expect(lines()).toHaveLength(0);
  });

  it('Waiting on you sits right under the Ask box and its chips, above the topics and People', async () => {
    mocks.activity = [mention('s-launch', 'u-hugo', 'Hugo Renaudin')];
    mocks.live = { kind: 'live', savedAt: NOW, themes: [theme(1)] };
    mocks.pulse = {
      success: true,
      data: {
        cached: false,
        briefing: {
          greeting: '',
          summary: '',
          pickBackUp: [],
          perRig: [],
          perPerson: [{ userId: 'u1', name: 'Dylan', avatarUrl: null, line: 'You.', isSelf: true }],
          generatedAt: new Date(NOW).toISOString(),
          degraded: false,
        },
      },
    };
    await mount();
    const center = host.querySelector<HTMLElement>('[data-testid="home-center"]')!;
    const ask = center.querySelector('input[placeholder="Ask across your spaces…"]')!;
    const needsYou = center.querySelector('[data-testid="waiting-on-you"]')!;
    expect(needsYou.textContent).toContain('Hugo mentioned you · #launch');
    const people = center.querySelector('[data-testid="home-people"]')!;
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(ask, needsYou)).toBe(true);
    expect(follows(needsYou, section()!)).toBe(true);
    expect(follows(section()!, people)).toBe(true);
  });

  it("shows this account's last topics from this computer when the relay can't answer", async () => {
    mocks.live = { kind: 'cached', savedAt: NOW - 3_600_000, themes: [theme(2)] };
    await mount();
    expect(lineIds()).toEqual(['thm_2']);
  });

  it('shows the pulse summary under the greeting, with no "updated" line; the Ask box and its chips stay', async () => {
    mocks.live = { kind: 'live', savedAt: NOW, themes: [] };
    mocks.pulse = {
      success: true,
      data: {
        cached: true,
        briefing: {
          greeting: '',
          summary: 'Launch prep moved along and pricing shipped.',
          pickBackUp: [],
          perRig: [],
          perPerson: [
            { userId: 'u1', name: 'Dylan', avatarUrl: null, line: 'You prepped the launch.', isSelf: true },
          ],
          generatedAt: new Date(NOW).toISOString(),
          degraded: false,
        },
      },
    };
    await mount();
    expect(host.querySelector('[data-testid="pulse-summary"]')?.textContent).toBe(
      'Launch prep moved along and pricing shipped.'
    );
    expect(host.textContent).not.toMatch(/updated .* ago/);
    expect(host.querySelector('input[placeholder="Ask across your spaces…"]')).not.toBeNull();
    expect(host.textContent).toContain("What's blocked?");
  });

  it("leads each row's status line with its busiest theme of the day; clicking the row opens the Room plainly", async () => {
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
    expect(mocks.requests).toEqual([]);
  });
});
