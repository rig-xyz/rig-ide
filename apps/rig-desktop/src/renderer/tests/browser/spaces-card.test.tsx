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
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { SpacesCard } from '@renderer/features/home/spaces-card';
import { SPACE_NOT_SET_UP_TOOLTIP, type HomeRigRow } from '@renderer/features/home/home-sections';
import { DICE_FACES, idlePattern } from '@renderer/features/home/space-status-state';
import { writeLastSeen, writeOpenedAt } from '@renderer/features/spaces/room-read-marker';
import type { RigSpaceStatus } from '@shared/rig/space-status';

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
