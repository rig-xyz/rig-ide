import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lane J: a joined-but-not-downloaded space on Home's Spaces card is no
 * dead end — clicking the row downloads (`rig attach`) and opens it; the
 * ⋯ menu carries Download/Locate…; a space's menu and its confirm dialog
 * say "space", not "rig".
 */

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  locate: vi.fn(),
  pickDir: vi.fn(),
  /** Each folder's sync state, by path; anything not listed is syncing fine. */
  health: {} as Record<string, SyncHealth>,
  getHealth: vi.fn(),
  startSync: vi.fn(),
  /** Main's "sync state changed" listeners. */
  listeners: [] as ((data: { path: string | null }) => void)[],
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openSelectDirectoryDialog: (...args: unknown[]) => mocks.pickDir(...args) },
    rig: {
      spacesConnection: { listMembers: async () => ({ success: true, data: [] }) },
      share: { collaborators: async () => ({ success: true, data: [] }) },
      join: {
        attach: (...args: unknown[]) => mocks.attach(...args),
        locate: (...args: unknown[]) => mocks.locate(...args),
      },
      syncHealth: {
        get: async ({ paths }: { paths: string[] }) => {
          mocks.getHealth(paths);
          return Object.fromEntries(paths.map((p) => [p, mocks.health[p] ?? { state: 'running' }]));
        },
        start: async ({ path }: { path: string }) => {
          mocks.startSync(path);
          mocks.health[path] = { state: 'running' };
          return { success: true, data: { state: 'running' } };
        },
      },
    },
  },
  events: {
    on: vi.fn((_channel: unknown, cb: (data: { path: string | null }) => void) => {
      mocks.listeners.push(cb);
      return () => {
        mocks.listeners = mocks.listeners.filter((l) => l !== cb);
      };
    }),
  },
}));

import { SpacesCard } from '@renderer/features/home/spaces-card';
import { SPACE_NOT_SET_UP_TOOLTIP, type HomeRigRow } from '@renderer/features/home/home-sections';
import { DICE_FACES, idlePattern } from '@renderer/features/home/space-status-state';
import { writeLastSeen, writeOpenedAt } from '@renderer/features/spaces/room-read-marker';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import type { SyncHealth } from '@shared/rig/sync-health';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function menuItem(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === text
  );
}

const relayOnlySpace: HomeRigRow = {
  kind: 'relayOnly',
  bindingId: 'b-gentle',
  isSpace: true,
  name: 'gentle-island',
  disambiguator: null,
  canAutoJoin: true,
  role: 'editor',
  localPath: null,
  localPathPending: false,
  sessions: [],
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SpacesCard — a joined space not on this Mac yet', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    opened = [];
    mocks.attach.mockReset().mockResolvedValue({
      success: true,
      data: { localPath: '/Rig/gentle-island', syncing: true },
    });
    mocks.locate.mockReset().mockResolvedValue({ success: true, data: { localPath: '/elsewhere/gentle-island' } });
    mocks.pickDir.mockReset().mockResolvedValue('/elsewhere/gentle-island');
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={[relayOnlySpace]}
            statusByBinding={new Map()}
            selfUserId={null}
            onOpenPath={(path) => opened.push(path)}
          />
        </QueryClientProvider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function rowButton(): HTMLButtonElement {
    return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('gentle-island')
    )!;
  }

  async function openMenu(): Promise<void> {
    await act(async () => click(host.querySelector('[aria-label^="More actions for"]')!));
  }

  it('says clicking downloads it, and clicking the row downloads and opens it', async () => {
    expect(host.querySelector(`[aria-label="${SPACE_NOT_SET_UP_TOOLTIP}"]`)).not.toBeNull();
    expect(rowButton().disabled).toBe(false);

    let resolveAttach!: (v: unknown) => void;
    mocks.attach.mockReturnValueOnce(new Promise((resolve) => (resolveAttach = resolve)));
    await act(async () => click(rowButton()));
    expect(rowButton().disabled).toBe(true);
    expect(host.textContent).toContain('Downloading…');

    await act(async () => resolveAttach({ success: true, data: { localPath: '/Rig/gentle-island', syncing: true } }));
    await flush();
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b-gentle', name: 'gentle-island' });
    expect(opened).toEqual(['/Rig/gentle-island']);
  });

  it('shows the error on the row when the download fails', async () => {
    mocks.attach.mockResolvedValueOnce({ success: false, error: { message: 'Relay unreachable' } });
    await act(async () => click(rowButton()));
    await flush();
    expect(opened).toEqual([]);
    expect(host.textContent).toContain('Relay unreachable');
    expect(rowButton().disabled).toBe(false);
  });

  it('offers Download and Locate… in the ⋯ menu', async () => {
    await openMenu();
    expect(menuItem('Download')).toBeTruthy();
    await act(async () => click(menuItem('Locate…')!));
    await flush();
    expect(mocks.locate).toHaveBeenCalledWith({ bindingId: 'b-gentle', dir: '/elsewhere/gentle-island' });
    expect(opened).toEqual(['/elsewhere/gentle-island']);
  });

  it('says "Leave space…" and the dialog speaks of a space', async () => {
    await openMenu();
    expect(menuItem('Leave rig…')).toBeUndefined();
    await act(async () => click(menuItem('Leave space…')!));
    await flush();
    expect(document.body.textContent).toContain('Leave gentle-island?');
    expect(document.body.textContent).toContain('the space stays for its owner');
    const submit = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Leave space');
    expect(submit).toBeTruthy();
  });
});

// ── "E · what you missed": each row's tile and second line ──

describe('SpacesCard — what you missed', () => {
  const NOW = Date.now();
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const SELF = 'me';

  function localSpace(bindingId: string, name: string): HomeRigRow {
    return {
      kind: 'local',
      bindingId,
      isSpace: true,
      name,
      path: `/Rig/${name}`,
      lastOpenedAt: 0,
      sessions: [],
      paused: false,
      outsideHome: false,
      notARigAnymore: false,
      role: 'owner',
    };
  }

  function msgs(fromSeq: number, count: number, authorUserId = 'sam') {
    return Array.from({ length: count }, (_, i) => ({
      id: `m${fromSeq + i}`,
      seq: fromSeq + i,
      createdAt: iso((count - i) * 60_000),
      authorUserId,
      authorKind: 'user' as const,
    }));
  }

  const statuses: RigSpaceStatus[] = [
    { bindingId: 'w-live', running: [{ runId: 'r1', agent: 'claude', ownerUserId: SELF, startedAt: iso(60_000), activity: 'editing', title: 'metrics.md' }] },
    { bindingId: 'w-failed', running: [], lastRun: { status: 'failed', endedAt: iso(60 * 60_000), agent: 'codex', ownerUserId: SELF }, recentMessages: msgs(11, 2) },
    { bindingId: 'w-done', running: [], lastRun: { status: 'done', endedAt: iso(20 * 60_000), agent: 'claude', ownerUserId: 'sam', ownerName: 'Sam Lee' } },
    { bindingId: 'w-one', running: [], recentMessages: [...msgs(11, 1), ...msgs(12, 1, SELF)] },
    { bindingId: 'w-five', running: [], recentMessages: msgs(11, 5) },
    { bindingId: 'w-nine', running: [], recentMessages: msgs(11, 9) },
    { bindingId: 'w-idle', running: [], lastRun: { status: 'done', endedAt: iso(3 * 3_600_000), agent: 'claude', ownerUserId: 'sam' }, recentMessages: msgs(4, 2).map((m) => ({ ...m, createdAt: iso(4 * 3_600_000) })) },
    { bindingId: 'w-empty', running: [], recentMessages: [] },
  ];
  const rows = [
    localSpace('w-live', 'growth'),
    localSpace('w-failed', 'gentle-island'),
    localSpace('w-done', 'pricing'),
    localSpace('w-one', 'clear-canyon'),
    localSpace('w-five', 'calm-valley'),
    localSpace('w-nine', 'launch'),
    localSpace('w-idle', 'research'),
    localSpace('w-empty', 'lively-island'),
  ];

  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    localStorage.clear();
    // Every space last opened 2h ago, having read up to seq 10.
    for (const s of statuses) {
      writeLastSeen(s.bindingId, 10);
      writeOpenedAt(s.bindingId, NOW - 2 * 3_600_000);
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={rows}
            statusByBinding={new Map(statuses.map((s) => [s.bindingId, s]))}
            selfUserId={SELF}
            onOpenPath={() => {}}
          />
        </QueryClientProvider>
      );
    });
    // Show every row, not just the first six.
    const showAll = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Show all'));
    if (showAll) await act(async () => click(showAll));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  function rowOf(name: string): HTMLElement {
    const nameEl = [...host.querySelectorAll('span')].find((s) => s.textContent === name)!;
    return nameEl.closest('.group') as HTMLElement;
  }
  const tileOf = (name: string) => rowOf(name).querySelector<HTMLElement>('[data-tile]')!;
  const lineOf = (name: string) => rowOf(name).querySelector<HTMLElement>('[data-testid="space-status-line"]')!;
  const litOf = (name: string) =>
    [...tileOf(name).querySelectorAll('[data-lit]')].map((el) => [...el.parentElement!.children].indexOf(el));

  it('live wins: the 1b motion and the activity in words', () => {
    expect(tileOf('growth').dataset.tile).toBe('live');
    expect(tileOf('growth').querySelector('[data-state="editing"]')).not.toBeNull();
    expect(lineOf('growth').textContent).toBe('Claude editing metrics.md');
  });

  it('an unseen failure: the red cross, "Codex failed · 1h ago" in the error tone', () => {
    expect(tileOf('gentle-island').dataset.tile).toBe('failed');
    expect(tileOf('gentle-island').querySelector('[data-state="failed"]')).not.toBeNull();
    expect(lineOf('gentle-island').textContent).toBe('Codex failed · 1h ago');
    expect(lineOf('gentle-island').className).toContain('text-danger');
  });

  it('an unseen finish: the green check, "Sam\'s Claude finished · 20m ago" (someone else\'s agent is named as theirs)', () => {
    expect(tileOf('pricing').querySelector('[data-state="done"]')).not.toBeNull();
    expect(lineOf('pricing').textContent).toBe("Sam's Claude finished · 20m ago");
    expect(lineOf('pricing').className).toContain('text-text-secondary');
  });

  it('new messages as dice faces — yours never count; 5 is a plus; 9 of 9 is "9+"', () => {
    expect(tileOf('clear-canyon').dataset.tile).toBe('messages');
    expect(litOf('clear-canyon')).toEqual([...DICE_FACES[1]!]);
    expect(lineOf('clear-canyon').textContent).toBe('1 new message');
    expect(litOf('calm-valley')).toEqual([1, 3, 4, 5, 7]);
    expect(lineOf('calm-valley').textContent).toBe('5 new messages');
    expect(litOf('launch')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lineOf('launch').textContent).toBe('9+ new messages');
    expect(tileOf('launch').querySelector('.bg-accent')).not.toBeNull();
  });

  it("nothing for you: the space's own grey pattern and its last activity, or no activity yet", () => {
    expect(tileOf('research').dataset.tile).toBe('idle');
    expect(litOf('research')).toEqual(idlePattern('w-idle'));
    expect(tileOf('research').querySelector('.bg-text-muted')).not.toBeNull();
    expect(lineOf('research').textContent).toBe('3h ago');
    expect(lineOf('research').className).toContain('text-text-muted');
    expect(litOf('lively-island')).toEqual(idlePattern('w-empty'));
    expect(lineOf('lively-island').textContent).toBe('No activity yet');
  });

  it('rows are weighted by state: live, unread bold with its count, quiet dimmed', () => {
    const weightOf = (name: string) => rowOf(name).dataset.weight;
    const nameOf = (name: string) => [...rowOf(name).querySelectorAll('span')].find((s) => s.textContent === name)!;
    const countOf = (name: string) => rowOf(name).querySelector('[data-testid="space-row-count"]')?.textContent ?? null;

    expect(weightOf('growth')).toBe('live');
    expect(countOf('growth')).toBeNull();

    expect(weightOf('calm-valley')).toBe('unread');
    expect(nameOf('calm-valley').className).toContain('font-semibold');
    expect(countOf('calm-valley')).toBe('5');
    const dotOf = (name: string) => rowOf(name).querySelector<HTMLElement>('[data-testid="space-row-dot"]');
    expect(dotOf('calm-valley')?.dataset.dot).toBe('unread');
    expect(dotOf('growth')).toBeNull();
    expect(dotOf('research')).toBeNull();
    expect(tileOf('research').className).toContain('bg-bg-1');
    expect(countOf('launch')).toBe('9+');
    expect(weightOf('gentle-island')).toBe('unread');

    expect(weightOf('research')).toBe('quiet');
    expect(nameOf('research').className).toContain('text-text-secondary');
    expect(nameOf('research').className).not.toContain('font-semibold');
    expect(tileOf('research').className).toContain('opacity-55');
    expect(countOf('research')).toBeNull();
  });

  it('opening a space clears what you missed — Home re-reads the markers', async () => {
    await act(async () => {
      writeOpenedAt('w-failed', Date.now());
      writeLastSeen('w-failed', 12);
      writeLastSeen('w-nine', 19);
    });
    expect(tileOf('gentle-island').dataset.tile).toBe('idle');
    expect(lineOf('gentle-island').textContent).toBe('1m ago');
    expect(tileOf('launch').dataset.tile).toBe('idle');
  });
});

/**
 * 0.4.7: the "Not syncing · Start syncing" chip sat on top of the space
 * names. The sync state now lives in the row's own status line, under the
 * name, replacing the activity; it reads "Starting sync…" while main is
 * starting it; and it covers a space whose folder is only known by its
 * binding (steady-grove, never opened through the app).
 */
describe('SpacesCard — sync state in the status line', () => {
  const marketing: HomeRigRow = {
    kind: 'local',
    bindingId: 'bnd_5jpw95',
    isSpace: true,
    // Renamed: the folder keeps its original name.
    name: 'rig-marketing',
    path: '/Users/me/Rig/gentle-canyon',
    lastOpenedAt: 0,
    sessions: [],
    paused: false,
    outsideHome: false,
    notARigAnymore: false,
    role: 'owner',
  };
  const warmIsland: HomeRigRow = { ...marketing, bindingId: 'bnd_jak0s9', name: 'warm-island', path: '/Users/me/Rig/warm-island' };
  const steadyGrove: HomeRigRow = {
    kind: 'relayOnly',
    bindingId: 'bnd_g7hvvv',
    isSpace: true,
    name: 'steady-grove',
    disambiguator: null,
    canAutoJoin: true,
    role: 'owner',
    localPath: '/Users/me/Rig/steady-grove',
    localPathPending: false,
    sessions: [],
  };

  let host: HTMLDivElement;
  let root: Root;

  async function render(rows: HomeRigRow[]): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard rows={rows} statusByBinding={new Map()} selfUserId={null} onOpenPath={() => {}} />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.health = {};
    mocks.listeners = [];
    mocks.getHealth.mockReset();
    mocks.startSync.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function rowOf(name: string): HTMLElement {
    const nameEl = [...host.querySelectorAll('span')].find((el) => el.textContent === name)!;
    return nameEl.closest('[data-testid="space-row"]') as HTMLElement;
  }
  const lineOf = (name: string) => rowOf(name).querySelector<HTMLElement>('[data-testid="space-status-line"]')!;
  const nameOf = (name: string) => rowOf(name).querySelector<HTMLElement>('[data-testid="space-row-name"]')!;

  it('says it in the status line under the name, with a link to fix it; the name line holds only the name', async () => {
    mocks.health[marketing.path] = { state: 'stopped' };
    await render([marketing]);

    const line = lineOf('rig-marketing');
    expect(line.textContent).toBe('Not syncing on this computer·Start syncing');
    expect(line.dataset.syncState).toBe('stopped');
    expect(line.className).toContain('text-warning');
    expect(line.title).toBe('Sync isn’t running on this computer. Your files may be out of date.');
    // The words truncate inside the row; the link keeps its place.
    expect(line.firstElementChild!.className).toContain('truncate');
    expect(line.querySelector('[data-testid="sync-health-action"]')!.className).toContain('shrink-0');
    // Name and status line share one column; nothing about sync sits beside them.
    expect(nameOf('rig-marketing').textContent).toBe('#rig-marketing');
    expect(nameOf('rig-marketing').parentElement).toBe(line.parentElement);
    expect(rowOf('rig-marketing').querySelectorAll('[data-testid="sync-health-notice"]')).toHaveLength(0);
    // The action is no longer inside the row's open button.
    expect(nameOf('rig-marketing').contains(line)).toBe(false);
    // Asked by folder, not by the space's display name.
    expect(mocks.getHealth).toHaveBeenCalledWith(['/Users/me/Rig/gentle-canyon']);
  });

  it('starts it from the line, and the line goes back to the activity at once', async () => {
    mocks.health[marketing.path] = { state: 'stopped' };
    await render([marketing]);
    await act(async () => click(lineOf('rig-marketing').querySelector('[data-testid="sync-health-action"]')!));
    await flush();
    expect(mocks.startSync).toHaveBeenCalledWith('/Users/me/Rig/gentle-canyon');
    expect(lineOf('rig-marketing').dataset.syncState).toBeUndefined();
    expect(lineOf('rig-marketing').textContent).toBe('No activity yet');
  });

  it('reads "Starting sync…" while main is starting it, quietly and with nothing to press', async () => {
    mocks.health[marketing.path] = { state: 'starting' };
    mocks.health[warmIsland.path] = { state: 'starting' };
    await render([marketing, warmIsland]);
    for (const name of ['rig-marketing', 'warm-island']) {
      expect(lineOf(name).textContent).toBe('Starting sync…');
      expect(lineOf(name).dataset.syncState).toBe('starting');
      expect(lineOf(name).className).toContain('text-text-muted');
      expect(lineOf(name).querySelector('[data-testid="sync-health-action"]')).toBeNull();
    }
  });

  it('re-reads the moment main says a folder changed, not at the next poll', async () => {
    mocks.health[marketing.path] = { state: 'starting' };
    await render([marketing]);
    mocks.health[marketing.path] = { state: 'running' };
    await act(async () => {
      for (const listener of mocks.listeners) listener({ path: '/Users/me/Rig/gentle-canyon' });
    });
    await flush();
    expect(lineOf('rig-marketing').textContent).toBe('No activity yet');
  });

  it('covers a space whose folder is only known by its binding', async () => {
    mocks.health['/Users/me/Rig/steady-grove'] = { state: 'stopped' };
    await render([steadyGrove]);
    expect(mocks.getHealth).toHaveBeenCalledWith(['/Users/me/Rig/steady-grove']);
    expect(lineOf('steady-grove').textContent).toBe('Not syncing on this computer·Start syncing');
  });
});

describe("SpacesCard — the row's topic of the day", () => {
  const NOW = Date.now();
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const launch: HomeRigRow = {
    kind: 'local',
    bindingId: 'b-launch',
    isSpace: true,
    name: 'launch',
    path: '/Users/me/Rig/launch',
    lastOpenedAt: 0,
    sessions: [],
    paused: false,
    outsideHome: false,
    notARigAnymore: false,
    role: 'owner',
  };
  const quiet: HomeRigRow = { ...launch, bindingId: 'b-quiet', name: 'quiet', path: '/Users/me/Rig/quiet' };
  const topic = (bindingId: string, name: string): RigRecentTheme => ({
    themeId: `thm_${name}`,
    bindingId,
    spaceName: 'launch',
    name,
    description: '',
    messageCount: 3,
    people: ['Hugo'],
    lastActivityAt: iso(60_000),
    lastSeq: 9,
  });
  const done: RigSpaceStatus = {
    bindingId: 'b-launch',
    running: [],
    lastRun: { status: 'done', endedAt: iso(20 * 60_000), agent: 'claude', ownerUserId: 'hugo', ownerName: 'Hugo Ross' },
  };

  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];

  async function render(rows: HomeRigRow[], status: RigSpaceStatus = done): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={rows}
            statusByBinding={new Map([[status.bindingId, status]])}
            selfUserId="me"
            topicByBinding={new Map([['b-launch', topic('b-launch', 'Bugs & Wishlist')]])}
            onOpenPath={(path) => opened.push(path)}
          />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    localStorage.clear();
    // Hugo's run finished after the space was last opened here.
    writeOpenedAt('b-launch', NOW - 2 * 3_600_000);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    opened = [];
    mocks.health = {};
    mocks.listeners = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const lineOf = (bindingId: string) =>
    host
      .querySelector(`[data-testid="space-row"][data-binding-id="${bindingId}"]`)!
      .querySelector<HTMLElement>('[data-testid="space-status-line"]')!;

  it('leads what is new since you looked with the topic', async () => {
    await render([launch, quiet]);
    expect(lineOf('b-launch').textContent).toBe("Bugs & Wishlist · Hugo's Claude finished · 20m ago");
    // No topic today: the status alone.
    expect(lineOf('b-quiet').textContent).toBe('No activity yet');
  });

  it('leaves the topic off a live run: who is working owns the line', async () => {
    await render([launch], {
      bindingId: 'b-launch',
      running: [
        { runId: 'r1', agent: 'claude', ownerUserId: 'hugo', ownerName: 'Hugo Ross', startedAt: iso(60_000), activity: 'editing', title: 'Pricing.md' },
      ],
    });
    expect(lineOf('b-launch').textContent).toBe("Hugo's Claude editing Pricing.md");
  });

  it('seen, active today: the topic and when', async () => {
    writeOpenedAt('b-launch', NOW);
    await render([launch]);
    expect(lineOf('b-launch').textContent).toBe('Bugs & Wishlist · 20m ago');
  });

  it('the sync state still takes the whole line', async () => {
    mocks.health[launch.path] = { state: 'stopped' };
    await render([launch]);
    expect(lineOf('b-launch').textContent).toBe('Not syncing on this computer·Start syncing');
    expect(lineOf('b-launch').textContent).not.toContain('Bugs');
  });

  it('opens the Room plainly, never on the topic its line shows', async () => {
    const { useRoomThemeRequest } = await import('@renderer/features/spaces/room-theme-request');
    const nameButton = () =>
      host.querySelector<HTMLButtonElement>('[data-binding-id="b-launch"] [data-testid="space-row-name"]')!;
    // The Room reads the request; a probe stands in for it here.
    const seen: string[] = [];
    function Probe() {
      useRoomThemeRequest({
        bindingId: 'b-launch',
        enabled: true,
        themes: { list: [{ id: 'thm_Bugs & Wishlist' }] } as never,
        focusOn: (target) => seen.push(target.kind === 'theme' ? target.themeId : target.kind),
      });
      return null;
    }
    const probeRoot = createRoot(document.createElement('div'));
    await act(async () => probeRoot.render(<Probe />));

    await render([launch]);
    await act(async () => nameButton().click());
    await flush();
    expect(opened).toEqual(['/Users/me/Rig/launch']);
    expect(seen).toEqual([]);
    await act(async () => probeRoot.unmount());
  });
});

describe('SpacesCard — faces only when they are the reason', () => {
  let host: HTMLDivElement;
  let root: Root;

  function space(bindingId: string, name: string): HomeRigRow {
    return {
      kind: 'local',
      bindingId,
      isSpace: true,
      name,
      path: `/Rig/${name}`,
      lastOpenedAt: 0,
      sessions: [],
      paused: false,
      outsideHome: false,
      notARigAnymore: false,
      role: 'owner',
    };
  }

  beforeEach(async () => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={[space('b-marketing', 'rig-marketing'), space('b-ops', 'rig-ops')]}
            statusByBinding={new Map()}
            selfUserId="me"
            onOpenPath={() => {}}
            facesByBinding={
              new Map([
                [
                  'b-marketing',
                  [
                    { userId: 'u-hugo', name: 'Hugo Renaudin', avatarUrl: null, kind: 'mentioned' as const },
                    { userId: 'u-raf', name: 'Rafael', avatarUrl: null, kind: 'running' as const },
                  ],
                ],
                ['b-ops', []],
              ])
            }
          />
        </QueryClientProvider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const facesOf = (bindingId: string) =>
    host.querySelector(`[data-testid="space-row"][data-binding-id="${bindingId}"] [data-testid="space-row-faces"]`);

  it('shows who mentioned you and whose agent runs, each saying why; a row with no reason has no faces', () => {
    const faces = facesOf('b-marketing')!;
    expect([...faces.children].map((f) => [f.getAttribute('data-reason'), f.getAttribute('title')])).toEqual([
      ['mentioned', 'Hugo Renaudin mentioned you'],
      ['running', "Rafael's agent is working here"],
    ]);
    expect(facesOf('b-ops')).toBeNull();
  });
});
