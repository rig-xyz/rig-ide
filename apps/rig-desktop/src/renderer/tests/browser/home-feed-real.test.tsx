import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

/**
 * The new Home with the orchestrator's Feed (`rpc.rig.feed.get`): its cards
 * replace the demo ones, asks first, and answering a card tells Rig.
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

const answers = vi.hoisted(() => [] as unknown[]);
const starts = vi.hoisted(() => [] as unknown[]);
const externals = vi.hoisted(() => [] as string[]);
/** What `rpc.rig.feed.get` answers; each test may swap it. */
const feedGet = vi.hoisted(() => ({ current: null as null | (() => unknown) }));
const realFeed = vi.hoisted(() => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const decision = (d: string) => ({
    do: d,
    conf: 0.9,
    who: 'Dylan',
    look: 'next_event',
    trigger: 'new event',
  });
  return {
    visible: [
      {
        situationId: 's_send',
        sources: ['gmail'],
        bindingId: null,
        title: 'Usage by email domain',
        description: '',
        participants: ['Maya Chen'],
        decision: decision('do_it'),
        card: {
          title: 'Send Maya the usage data',
          why: 'Maya asked before the Halcyon meeting [ev:i09].',
          action: '**Send the numbers.** Pull usage by email domain.',
          choices: [
            { verb: 'start', label: 'Pull the numbers', lead: 'Pull usage by email domain', tail: '' },
            { verb: 'open', label: 'Open the email', lead: 'Open the email from Maya', tail: '' },
          ],
          refsOk: true,
        },
        updatedAt: at,
      },
      {
        situationId: 's_vendor',
        sources: ['linear'],
        bindingId: null,
        title: 'Vendor list',
        description: '',
        participants: ['Riyad Hasanov'],
        decision: decision('ask_you'),
        card: {
          title: 'Pick the vendor list for Riyad',
          why: 'Riyad is blocked on the registry [item:ULY-229].',
          action: '**Reply to Riyad.** Choose the 11 or the 8.',
          refsOk: true,
        },
        updatedAt: at,
      },
    ],
    queued: [],
    following: [],
    snoozed: [],
    digest: [],
  };
});
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
      connectors: {
        list: async () => [
          { id: 'linear', state: 'connected' },
          { id: 'notion', state: 'connected' },
          { id: 'posthog', state: 'not_connected' },
        ],
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
      // No live Claude here: Home's chat falls back to its own messages.
      homeChat: { open: async () => ({ success: false, error: 'no Claude in tests' }) },
      feed: {
        get: async () => feedGet.current?.() ?? { success: true, data: realFeed },
        answer: async (input: unknown) => {
          answers.push(input);
          return { success: true, data: null };
        },
        start: async (input: unknown) => {
          starts.push(input);
          return { success: true, data: { runId: 'r1' } };
        },
        situation: async () => ({
          success: true,
          data: { id: 's_send', events: [{ id: 'e1', url: 'https://mail.example/thread/1' }, { id: 'e2', url: null }] },
        }),
      },
      orch: { query: async () => ({ success: true, data: { kind: 'working', rows: [] } }) },
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
vi.mock('@renderer/lib/open-external-link', () => ({
  confirmOpenExternalLink: (url: string) => externals.push(url),
}));

import { NewHome } from '@renderer/features/home-feed/new-home';

const SIGNED_OUT = "signed out, it says so and offers sign-in, never the demo";
const UNREACHABLE = "can't reach Rig, it says so and Try again brings the cards";
const feedAnswers: Record<string, () => unknown> = {
  [SIGNED_OUT]: () => ({ success: false, error: { kind: 'notSignedIn', message: 'Not signed in to Rig.' } }),
  [UNREACHABLE]: () => ({ success: false, error: { kind: 'relay', message: "Could not load your Feed. Rig can't reach the server right now." } }),
};

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

beforeEach(async (ctx) => {
  feedGet.current = feedAnswers[ctx.task.name] ?? null;
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

describe('NewHome with the orchestrator Feed', () => {
  it("shows Rig's cards instead of the demo ones, asks first, with ticket chips", async () => {
    await vi.waitFor(() => expect(feedRow('prp_earn')).toBeNull());
    const rows = [...host.querySelectorAll<HTMLElement>('[data-feed-id]')].map(
      (r) => r.dataset.feedId
    );
    expect(rows).toEqual(['sit:s_vendor', 'sit:s_send']);
    expect(feedRow('sit:s_vendor')!.textContent).toContain('Pick the vendor list for Riyad');
    expect(feedRow('sit:s_vendor')!.textContent).toContain('ULY-229');
    expect(feedRow('sit:s_vendor')!.textContent).not.toContain('ev:');
  });

  it('Reply starts a session that drafts the reply and sends nothing, and the card leaves', async () => {
    starts.length = 0;
    await vi.waitFor(() => expect(feedRow('sit:s_vendor')).not.toBeNull());
    await click(button(feedRow('sit:s_vendor')!, /Reply/));
    await vi.waitFor(() => expect(feedRow('sit:s_vendor')).toBeNull());
    expect(starts).toEqual([
      {
        situationId: 's_vendor',
        task: "Draft this reply: Reply to Riyad: choose the 11 or the 8. Show me the draft here; don't send or post anything until I say so.",
        // In Ask first, so nothing it does goes ahead without you.
        reply: true,
      },
    ]);
  });

  it("Open opens the card's source and leaves the card where it is", async () => {
    externals.length = 0;
    await vi.waitFor(() => expect(feedRow('sit:s_send')).not.toBeNull());
    // Step to the card's second choice, Open.
    await click(button(feedRow('sit:s_send')!, 'Next option'));
    const open = button(feedRow('sit:s_send')!, /^Open/);
    await click(open);
    await vi.waitFor(() => expect(externals).toEqual(['https://mail.example/thread/1']));
    expect(feedRow('sit:s_send')).not.toBeNull();
  });

  it(SIGNED_OUT, async () => {
    await vi.waitFor(() => expect(host.querySelector('[data-feed-notice="signed-out"]')).not.toBeNull());
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(button(host, 'Sign in to Rig')).toBeTruthy();
    // No demo spaces on the rail either: only the account's own.
    expect(host.querySelector('nav')!.textContent).not.toContain('ulys-backlog');
  });

  it(UNREACHABLE, async () => {
    await vi.waitFor(() => expect(host.querySelector('[data-feed-notice="unreachable"]')).not.toBeNull());
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    feedGet.current = null;
    await click(button(host, 'Try again'));
    await vi.waitFor(() => expect(feedRow('sit:s_vendor')).not.toBeNull());
    expect(host.querySelector('[data-feed-notice]')).toBeNull();
  });
});
