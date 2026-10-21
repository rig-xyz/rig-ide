import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

/**
 * The new Home (Settings › Advanced › Preview the new Home): the rail merges
 * the account's real spaces with the Feed's demo ones, the Feed's options
 * swap the text and the verb, Ignore leaves a slim row with Undo, acting on
 * an item moves its work into the rail, and the middle swaps the chat for
 * what's open.
 */

const space = (id: string, name: string) => ({
  id,
  name,
  kind: 'space' as const,
  role: 'owner',
  lastSyncedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  relayHost: 'tap-relay.fly.dev',
});

const layoutActions = vi.hoisted(() => [] as unknown[]);

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      homeLayout: {
        get: async () => ({
          groupBy: 'custom',
          sortBy: 'recent',
          showQuiet: true,
          showEmptyGroups: false,
          collapsed: [],
          groups: [{ id: 'grp_internal', name: 'Internal', collapsed: false, spaces: ['b-ops'] }],
        }),
        apply: async ({ action }: { action: unknown }) => {
          layoutActions.push(action);
          return null;
        },
      },
      account: {
        me: async () => ({
          success: true,
          data: {
            id: 'u1',
            clerkUserId: 'c1',
            email: 'd@x.co',
            name: 'Dylan Bourgeois',
            avatarUrl: null,
            createdAt: '',
          },
        }),
        workspaces: async () => ({
          success: true,
          data: [space('b-ops', 'rig-ops'), space('b-launch', 'launch')],
        }),
      },
      recent: {
        recentRigs: async () => [],
        resolveLocalPaths: async () => ({ 'b-launch': '/Users/me/Rig/launch' }),
      },
      sessions: { listRecentAcrossRigs: async () => [] },
      spaceStatus: { get: async () => ({ success: true, data: [] }) },
      spacesConnection: {
        listMembers: async ({ bindingId }: { bindingId: string }) => ({
          success: true,
          data:
            bindingId === 'b-launch'
              ? [
                  {
                    userId: 'u1',
                    clerkUserId: 'c1',
                    name: 'Dylan',
                    email: '',
                    role: 'owner',
                    avatarUrl: null,
                  },
                  {
                    userId: 'u2',
                    clerkUserId: 'c2',
                    name: 'Hugo',
                    email: '',
                    role: 'member',
                    avatarUrl: 'https://img.example/hugo.png',
                  },
                ]
              : [
                  {
                    userId: 'u1',
                    clerkUserId: 'c1',
                    name: 'Dylan',
                    email: '',
                    role: 'owner',
                    avatarUrl: null,
                  },
                ],
        }),
      },
      notifications: {
        summary: async () => ({
          spaces: [{ bindingId: 'b-ops', spaceUnread: 4 }],
          invitesUnread: 0,
          directUnreadTotal: 0,
        }),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { NewHome } from '@renderer/features/home-feed/new-home';

beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Wide enough that the Feed stays open (it folds below 1060px); the rail still folds below 1180px.
  await page.viewport(1100, 900);
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let host: HTMLDivElement;
let root: Root;
const opened: Array<[string, unknown]> = [];
const settingsOpened: Array<string | undefined> = [];

beforeEach(async () => {
  opened.length = 0;
  settingsOpened.length = 0;
  layoutActions.length = 0;
  host = document.createElement('div');
  host.style.height = '900px';
  host.style.width = '1400px';
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NewHome
          onOpenPath={(path, opts) => opened.push([path, opts])}
          onContinueSession={() => {}}
          onOpenSettings={(page) => settingsOpened.push(page)}
          updateReady={false}
        />
      </QueryClientProvider>
    );
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const rail = () => host.querySelector('nav')!;
const feedRow = (id: string) => host.querySelector<HTMLElement>(`[data-feed-id="${id}"]`);
const button = (scope: ParentNode, name: string | RegExp) =>
  [...scope.querySelectorAll('button')].find((b) =>
    typeof name === 'string'
      ? b.textContent?.trim() === name || b.getAttribute('aria-label') === name
      : name.test(b.textContent ?? '')
  );

async function click(el: Element | undefined | null): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

describe('NewHome', () => {
  it('greets you by first name and counts the Feed', () => {
    expect(host.textContent).toContain(', Dylan.');
    expect(host.querySelector('aside')!.textContent).toContain('2 need you · 4 up next');
  });

  it('merges real spaces into the rail: a demo space takes the real one with its name, in your groups', () => {
    const ids = [...rail().querySelectorAll('[data-rail-id]')].map((e) =>
      e.getAttribute('data-rail-id')
    );
    // Your groups first (rig-ops is in Internal), then Ungrouped, demo spaces leading it.
    expect(ids.slice(0, 2)).toEqual(['rig-ops', 's-domains']);
    expect(ids.slice(2, 5)).toEqual(['ulys-backlog', 's-triage', 's-stale']);
    expect(ids.filter((id) => id === 'rig-ops')).toHaveLength(1);
    expect(ids.at(-1)).toBe('b-launch');
    // The merged space keeps its real unread, named for screen readers in the folded rail.
    expect(rail().querySelector('[data-rail-id="rig-ops"]')!.getAttribute('aria-label')).toBe(
      '# rig-ops, 4 unread'
    );
  });

  it('shows your groups: a group folds under its header, and a space dragged onto it moves there', async () => {
    // The rail is folded to icons below 1180px; open it to see the headers.
    await click(button(rail(), 'Open the sidebar'));
    const header = button(rail(), /Internal/)!;
    expect(header.textContent).toContain('1');
    expect(rail().textContent).toContain('Ungrouped');
    await click(header);
    expect(layoutActions).toContainEqual({
      type: 'setGroupCollapsed',
      id: 'grp_internal',
      collapsed: true,
    });

    const launch = rail().querySelector('[data-rail-id="b-launch"]')!;
    const data = new DataTransfer();
    await act(async () => {
      launch.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      header.parentElement!.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
      );
      header.parentElement!.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
      );
    });
    await flush();
    expect(layoutActions).toContainEqual({
      type: 'moveSpace',
      bindingId: 'b-launch',
      groupId: 'grp_internal',
    });
  });

  it('stepping the options swaps the text, the space label and the verb', async () => {
    const row = feedRow('ask_429')!;
    expect(row.textContent).toContain('New space');
    expect(button(row, 'Create space')).toBeTruthy();
    await click(button(row, 'Next option'));
    const after = feedRow('ask_429')!;
    expect(after.textContent).toContain('Block it now.');
    expect(after.textContent).toContain('#ulys-backlog');
    expect(button(after, 'Reply')).toBeTruthy();
  });

  it('Ignore leaves a slim row with Undo, and Undo brings the item back', async () => {
    const row = feedRow('prp_hugo')!;
    await click(button(row, 'More'));
    await click(
      [...host.querySelectorAll('[role=menuitem]')].find((b) => b.textContent?.includes('Ignore'))
    );
    expect(feedRow('prp_hugo')).toBeNull();
    expect(host.textContent).toContain('Ignored Reply to Hugo on manifesto v2');
    expect(host.querySelector('aside')!.textContent).toContain('3 up next');
    await click(button(host.querySelector('aside')!, 'Undo'));
    expect(feedRow('prp_hugo')).toBeTruthy();
  });

  it('Start session takes the item out of the Feed and puts a new session in its space', async () => {
    await click(button(feedRow('prp_earn')!, 'Start session'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    await flush();
    expect(feedRow('prp_earn')).toBeNull();
    // Below 1180px the rail folds to icons and names the entry for screen readers.
    const added = rail().querySelector('[data-rail-id^="s-new"]');
    expect(added?.getAttribute('aria-label') ?? added?.textContent).toContain(
      'Triage the new Earn bugs'
    );
  });

  it('a rail entry opens its context in the middle, and ← Home comes back to the chat', async () => {
    await click(rail().querySelector('[data-rail-id="s-triage"]'));
    const middle = host.querySelector('section')!;
    expect(middle.textContent).toContain('Claude needs you');
    expect(middle.textContent).toContain('Read the brief: .rig/briefs/urgent-triage.md');
    await click(button(middle, /Home/));
    expect(host.querySelector('textarea[aria-label="Message Rig"]')).toBeTruthy();
  });

  it('a space on disk opens straight into its Room from the rail', async () => {
    await click(rail().querySelector('[data-rail-id="b-launch"]'));
    expect(opened).toEqual([['/Users/me/Rig/launch', { kind: 'space' }]]);
  });

  it('a space is bold only while something in it is unread, and shows member photos', async () => {
    await click(button(rail(), 'Open the sidebar'));
    const name = (id: string) => rail().querySelector(`[data-rail-id="${id}"] .truncate`)!;
    expect(name('rig-ops').className).toContain('font-semibold');
    expect(name('b-launch').className).not.toContain('font-semibold');
    expect(rail().querySelector('[data-rail-id="b-launch"] img')?.getAttribute('src')).toBe(
      'https://img.example/hugo.png'
    );
  });

  it('you and Settings sit at the foot of the rail', async () => {
    await click(rail().querySelector('[aria-label="Dylan Bourgeois, your account"]'));
    await click(button(rail(), 'Settings'));
    expect(settingsOpened).toEqual(['account', undefined]);
  });

  it('the Feed folds to a strip of counts and opens again', async () => {
    const feed = () => host.querySelector('aside')!;
    await click(button(feed(), 'Fold the Feed'));
    expect(button(feed(), /Open the Feed: 2 need you, 4 up next/)).toBeFalsy();
    expect(
      feed().querySelector('[aria-label="Open the Feed: 2 need you, 4 up next"]')
    ).toBeTruthy();
    await click(button(feed(), 'Open the Feed'));
    expect(feed().textContent).toContain('Decide on the A7A5 restriction');
  });
});
