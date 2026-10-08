import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Many spaces on Home" v1 on the Spaces card: the header's ⋯ (group by,
 * sort by, show quiet, show empty groups), custom groups (sections,
 * collapse, new, rename, delete, drag to move or reorder, "Move to group…",
 * group two spaces dropped on each other), group by state, and the quiet
 * fold. Main's layout store is faked with the real reducer.
 */

const mocks = vi.hoisted(() => ({
  layout: null as unknown,
  applied: [] as unknown[],
  summary: { spaces: [] as unknown[], invitesUnread: 0, directUnreadTotal: 0 },
}));

vi.mock('@renderer/lib/ipc', async () => {
  const { applyHomeLayoutAction } = await import('@shared/rig/home-layout');
  return {
    rpc: {
      app: { openSelectDirectoryDialog: async () => null },
      rig: {
        spacesConnection: { listMembers: async () => ({ success: true, data: [] }) },
        share: { collaborators: async () => ({ success: true, data: [] }) },
        join: { attach: async () => null, locate: async () => null },
        syncHealth: {
          get: async ({ paths }: { paths: string[] }) =>
            Object.fromEntries(paths.map((p) => [p, { state: 'running' }])),
          start: async () => ({ success: true, data: { state: 'running' } }),
        },
        notifications: { summary: async () => mocks.summary },
        homeLayout: {
          get: async () => mocks.layout,
          apply: async ({ action }: { action: Parameters<typeof applyHomeLayoutAction>[1] }) => {
            mocks.applied.push(action);
            mocks.layout = applyHomeLayoutAction(mocks.layout as never, action);
            return mocks.layout;
          },
        },
      },
    },
    events: { on: vi.fn(() => () => {}) },
  };
});

import type { HomeRigRow } from '@renderer/features/home/home-sections';
import { SpacesCard } from '@renderer/features/home/spaces-card';
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from '@shared/rig/home-layout';
import type { RigSpaceStatus } from '@shared/rig/space-status';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function space(bindingId: string, name = bindingId): HomeRigRow {
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

/** A space whose last run ended `msAgo` ago (its only activity). */
const lastRun = (bindingId: string, msAgo: number): RigSpaceStatus => ({
  bindingId,
  running: [],
  lastRun: { status: 'stopped', endedAt: iso(msAgo), agent: 'claude', ownerUserId: 'me' },
});

const rows = [space('alpha'), space('beta'), space('gamma'), space('delta')];
const statuses = new Map(
  [
    lastRun('alpha', DAY),
    lastRun('beta', 2 * DAY),
    lastRun('gamma', 3 * DAY),
    lastRun('delta', 30 * DAY),
  ].map((s) => [s.bindingId, s])
);

const launch = (over: Partial<HomeLayout> = {}): HomeLayout => ({
  ...DEFAULT_HOME_LAYOUT,
  groups: [
    { id: 'g-launch', name: 'Launch', collapsed: false, spaces: ['beta'] },
    { id: 'g-ops', name: 'Ops', collapsed: false, spaces: ['gamma'] },
  ],
  ...over,
});

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function byText<T extends HTMLElement>(
  selector: string,
  text: string,
  root: ParentNode = document.body
): T | undefined {
  return [...root.querySelectorAll<T>(selector)].find((el) => el.textContent?.trim() === text);
}

const menuItem = (text: string) => byText<HTMLButtonElement>('[role^="menuitem"]', text);

function drag(
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  el: Element,
  dataTransfer: DataTransfer
): void {
  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
}

describe('SpacesCard — arranging many spaces', () => {
  let host: HTMLDivElement;
  let root: Root;

  async function render(
    layout: HomeLayout,
    statusByBinding: ReadonlyMap<string, RigSpaceStatus> = statuses
  ) {
    mocks.layout = layout;
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={rows}
            statusByBinding={statusByBinding}
            selfUserId="me"
            onOpenPath={() => {}}
          />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  /** Each visible section: its header text (or null) and its rows' binding ids. */
  function sections(): Array<[string | null, string[]]> {
    return [...host.querySelectorAll('[data-testid="space-section"]')].map((s) => [
      s.querySelector('[data-testid="space-section-header"]')?.textContent?.trim() ?? null,
      [...s.querySelectorAll('[data-testid="space-row"]')].map(
        (r) => r.getAttribute('data-binding-id')!
      ),
    ]);
  }

  const section = (key: string) => host.querySelector(`[data-section="${key}"]`)!;
  const rowEl = (id: string) => host.querySelector(`[data-binding-id="${id}"]`)!;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.applied = [];
    mocks.summary = { spaces: [], invitesUnread: 0, directUnreadTotal: 0 };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('the header menu: Group by and Sort by submenus, then the two toggles, and no Smart groups', async () => {
    await render(DEFAULT_HOME_LAYOUT);
    await act(async () => click(host.querySelector('[aria-label="Arrange spaces"]')!));
    const items = [
      ...document.body.querySelectorAll(
        '[role="menu"] > [role^="menuitem"], [role="menu"] > div > [role^="menuitem"]'
      ),
    ].map((el) => el.textContent?.trim());
    expect(items).toEqual(['Group by', 'Sort by', 'Show quiet spaces', 'Show empty groups']);
    expect(document.body.textContent).not.toContain('Smart groups');
    expect(menuItem('Show quiet spaces')!.getAttribute('aria-checked')).toBe('true');
    expect(menuItem('Show empty groups')!.getAttribute('aria-checked')).toBe('false');

    await act(async () => click(menuItem('Group by')!));
    expect(menuItem('Custom groups')!.getAttribute('aria-checked')).toBe('true');
    expect(menuItem('State')).toBeTruthy();
    expect(menuItem('None')).toBeTruthy();
    // The submenu stays open beside the menu: pressing in it doesn't close the menu.
    menuItem('State')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menuItem('Sort by')).toBeTruthy();
    await act(async () => click(menuItem('State')!));
    await flush();
    expect(mocks.applied).toEqual([{ type: 'setGroupBy', groupBy: 'state' }]);
    expect(menuItem('Group by')).toBeUndefined();
  });

  it('custom groups: each group with its count, then Ungrouped last', async () => {
    await render(launch());
    expect(sections()).toEqual([
      ['Launch1', ['beta']],
      ['Ops1', ['gamma']],
      ['Ungrouped2', ['alpha', 'delta']],
    ]);
  });

  it('with no groups yet, one list and a "New group" button', async () => {
    await render(DEFAULT_HOME_LAYOUT);
    expect(sections()).toEqual([[null, ['alpha', 'beta', 'gamma', 'delta']]]);
    expect(host.querySelector('[data-testid="new-group"]')).not.toBeNull();
  });

  it('collapses a group and remembers it', async () => {
    await render(launch());
    await act(async () => click(host.querySelector('[aria-label="Collapse Launch"]')!));
    await flush();
    expect(mocks.applied).toEqual([{ type: 'setGroupCollapsed', id: 'g-launch', collapsed: true }]);
    expect(sections()[0]).toEqual(['Launch1', []]);
    expect(host.querySelector('[aria-label="Expand Launch"]')).not.toBeNull();
  });

  it('"New group" makes one and lets you name it at once; it shows while still empty', async () => {
    await render(launch());
    await act(async () => click(host.querySelector('[data-testid="new-group"]')!));
    await flush();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
    expect(input.value).toBe('New group');
    expect(document.activeElement).toBe(input);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Research');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    await flush();
    // New groups go after the others; Ungrouped stays last.
    expect(sections().at(-2)).toEqual(['Research0', []]);
    expect(mocks.applied.map((a) => (a as { type: string }).type)).toEqual([
      'createGroup',
      'renameGroup',
    ]);
  });

  it('renames on double-click; deleting a group puts its spaces back in Ungrouped', async () => {
    await render(launch());
    const title = byText<HTMLButtonElement>('button', 'Launch1', host)!;
    await act(async () => title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
    expect(input.value).toBe('Launch');
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );

    await act(async () =>
      click(host.querySelector('[aria-label=\'More actions for group "Launch"\']')!)
    );
    await act(async () => click(menuItem('Delete group')!));
    await flush();
    expect(sections()).toEqual([
      ['Ops1', ['gamma']],
      ['Ungrouped3', ['alpha', 'beta', 'delta']],
    ]);
  });

  it('drags a space onto a group, and a grouped one back to Ungrouped', async () => {
    await render(launch());
    const dt = new DataTransfer();
    await act(async () => drag('dragstart', rowEl('alpha'), dt));
    await act(async () => drag('dragover', section('g-ops'), dt));
    await act(async () => drag('drop', section('g-ops'), dt));
    await flush();
    expect(mocks.applied).toEqual([{ type: 'moveSpace', bindingId: 'alpha', groupId: 'g-ops' }]);
    expect(sections().find(([h]) => h?.startsWith('Ops'))).toEqual(['Ops2', ['alpha', 'gamma']]);

    const dt2 = new DataTransfer();
    await act(async () => drag('dragstart', rowEl('beta'), dt2));
    await act(async () => drag('dragover', section('ungrouped'), dt2));
    await act(async () => drag('drop', section('ungrouped'), dt2));
    await flush();
    expect(sections().at(-1)).toEqual(['Ungrouped2', ['beta', 'delta']]);
  });

  it('reorders groups by dragging a header', async () => {
    await render(launch());
    const dt = new DataTransfer();
    const header = section('g-ops').querySelector('[data-testid="space-section-header"]')!;
    await act(async () => drag('dragstart', header, dt));
    await act(async () => drag('dragover', section('g-launch'), dt));
    await act(async () => drag('drop', section('g-launch'), dt));
    await flush();
    expect(mocks.applied).toEqual([{ type: 'reorderGroup', id: 'g-ops', toIndex: 0 }]);
    expect(sections().map(([h]) => h)).toEqual(['Ops1', 'Launch1', 'Ungrouped2']);
  });

  it('dropping one ungrouped space on another offers to group the two', async () => {
    await render(DEFAULT_HOME_LAYOUT);
    const dt = new DataTransfer();
    await act(async () => drag('dragstart', rowEl('alpha'), dt));
    await act(async () => drag('dragover', rowEl('delta'), dt));
    await act(async () => drag('drop', rowEl('delta'), dt));
    await flush();
    const offer = host.querySelector('[data-testid="group-both-offer"]')!;
    expect(offer.textContent).toContain('Group alpha and delta?');
    await act(async () => click(byText('button', 'Make group', offer)!));
    await flush();
    expect(mocks.applied).toMatchObject([
      { type: 'createGroup', name: 'New group', spaces: ['alpha', 'delta'] },
    ]);
    // Made and ready to name.
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!.value).toBe(
      'New group'
    );
    expect(sections().map(([, ids]) => ids)).toEqual([
      ['alpha', 'delta'],
      ['beta', 'gamma'],
    ]);
    expect(host.querySelector('[data-testid="group-both-offer"]')).toBeNull();
  });

  it('"Move to group…" in a row\'s menu', async () => {
    await render(launch());
    await act(async () => click(host.querySelector('[aria-label=\'More actions for "alpha"\']')!));
    await act(async () => click(menuItem('Move to group…')!));
    expect(menuItem('No group')!.getAttribute('aria-checked')).toBe('true');
    await act(async () => click(menuItem('Launch')!));
    await flush();
    expect(mocks.applied).toEqual([{ type: 'moveSpace', bindingId: 'alpha', groupId: 'g-launch' }]);
    expect(sections()[0]).toEqual(['Launch2', ['alpha', 'beta']]);
  });

  it('group by state: Needs you, Active, Quiet', async () => {
    mocks.summary = {
      spaces: [
        {
          bindingId: 'gamma',
          name: 'gamma',
          latestDirect: {
            type: 'mention',
            actor: { kind: 'user', userId: null, name: 'Hugo', agent: null },
          },
          level: 'all',
          lastReadSeq: 0,
          spaceUnread: 0,
          directUnread: 1,
          directUnreadNoMessage: 0,
        },
      ],
      invitesUnread: 0,
      directUnreadTotal: 1,
    };
    await render(launch({ groupBy: 'state' }));
    expect(sections()).toEqual([
      ['Needs you1', ['gamma']],
      ['Active2', ['alpha', 'beta']],
      ['Quiet1', ['delta']],
    ]);
    expect(byText('button', 'Needs you1', host)).toBeTruthy();
    expect(byText('button', 'Unread1', host)).toBeTruthy();
    expect(host.querySelector('[data-testid="new-group"]')).toBeNull();
  });

  it('the filter chips are All, Needs you and Unread, and still filter across sections', async () => {
    await render(launch());
    const chips = [...host.querySelectorAll('button')]
      .map((b) => b.textContent ?? '')
      .filter((t) => /^(All|Needs you|Unread|Active|★ Pinned)/.test(t));
    expect(chips).toEqual(['All', 'Needs you', 'Unread']);
    await act(async () => click(byText('button', 'Unread', host)!));
    expect(host.textContent).toContain('No spaces match this filter.');
  });

  it('"Show quiet spaces" off folds them into one line at the bottom', async () => {
    await render(launch({ showQuiet: false }));
    expect(sections()).toEqual([
      ['Launch1', ['beta']],
      ['Ops1', ['gamma']],
      ['Ungrouped1', ['alpha']],
    ]);
    const fold = host.querySelector('[data-testid="quiet-fold"]')!;
    expect(fold.textContent).toBe('1 quiet space');
    expect(rowEl('delta')).toBeNull();
    await act(async () => click(fold));
    expect(rowEl('delta')).not.toBeNull();
    expect(fold.getAttribute('aria-expanded')).toBe('true');
  });
});
