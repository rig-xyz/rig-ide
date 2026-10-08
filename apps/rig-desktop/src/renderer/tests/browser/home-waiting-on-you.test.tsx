import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's "Waiting on you": only direct, unread things, each with its quote,
 * the message before it as context, and one action. Reply sends inline
 * through the Room's own message shape, Accept joins, Approve answers your
 * own agent from this computer's copy of the run. A done item fades with a
 * line saying so, then clears. Nothing waiting says so in one line.
 */

const mocks = vi.hoisted(() => ({
  activity: [] as unknown[],
  invites: [] as unknown[],
  localEvents: null as unknown[] | null,
  postMessage: vi.fn(),
  markRead: vi.fn(),
  accept: vi.fn(),
  attach: vi.fn(),
  resolve: vi.fn(),
  listMessages: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      notifications: {
        activity: async () => ({ success: true, data: mocks.activity }),
        markRead: (...args: unknown[]) => mocks.markRead(...args),
      },
      share: {
        listMyInvites: async () => ({ success: true, data: { invites: mocks.invites } }),
        acceptMyInvite: (...args: unknown[]) => mocks.accept(...args),
      },
      join: { attach: (...args: unknown[]) => mocks.attach(...args) },
      spacesConnection: {
        listMessages: (...args: unknown[]) => mocks.listMessages(...args),
        postMessage: (...args: unknown[]) => mocks.postMessage(...args),
      },
      spacesDispatch: {
        localRunEvents: async () => ({ events: mocks.localEvents }),
        resolvePermission: (...args: unknown[]) => mocks.resolve(...args),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { WaitingOnYouSection } from '@renderer/features/home/needs-you-section';
import type { HomeRigRow } from '@renderer/features/home/home-sections';
import { row } from '@shared/rig/notification-fixture';
import type { RigSpaceStatus } from '@shared/rig/space-status';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

const space = (bindingId: string, name: string): HomeRigRow => ({
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
});

const hugoMention = row({
  id: '603',
  type: 'mention',
  tier: 'direct',
  bindingId: 'b-mkt',
  spaceName: 'rig-marketing',
  actor: { kind: 'user', userId: 'u-hugo', name: 'Hugo Renaudin', agent: null },
  messageId: 'msg-603',
  messageSeq: 1334,
  body: '@Dylan Bourgeois wdyt',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
});

describe('Home: Waiting on you', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];

  async function mount(statusByBinding: ReadonlyMap<string, RigSpaceStatus> = new Map()): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <WaitingOnYouSection
            spaceRows={[space('b-mkt', 'rig-marketing'), space('b-ops', 'rig-ops')]}
            statusByBinding={statusByBinding}
            selfUserId="u-me"
            onOpenPath={(path) => opened.push(path)}
          />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  const items = () => [...host.querySelectorAll<HTMLElement>('[data-testid="waiting-item"]')];

  beforeEach(() => {
    vi.useRealTimers();
    mocks.activity = [];
    mocks.invites = [];
    mocks.localEvents = null;
    mocks.postMessage.mockReset().mockResolvedValue({ success: true, data: { id: 'msg-new' } });
    mocks.markRead.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.accept.mockReset().mockResolvedValue({ success: true, data: { bindingId: 'b-warm', becameMember: true } });
    mocks.attach.mockReset().mockResolvedValue({ success: true, data: { localPath: '/Rig/warm-island', syncing: true } });
    mocks.resolve.mockReset().mockResolvedValue({ resolved: true });
    mocks.listMessages.mockReset().mockResolvedValue({
      success: true,
      data: [
        {
          id: 'msg-602',
          seq: 1333,
          author: { userId: 'c-hugo', name: 'Hugo Renaudin', avatarUrl: null, kind: 'user' },
          kind: 'text',
          body: '@claude looks like: mandatory onboarding call',
          meta: null,
          createdAt: '',
        },
      ],
    });
    opened = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("says so in one line when nothing's waiting", async () => {
    mocks.activity = [row({ id: '1', type: 'message' }), row({ id: '2', type: 'mention', tier: 'direct', readAt: '2026-10-08T00:00:00Z' })];
    await mount();
    expect(host.querySelector('h2')?.textContent).toBe('Waiting on you');
    expect(host.querySelector('[data-testid="waiting-empty"]')?.textContent).toBe('Nothing’s waiting on you.');
    expect(items()).toHaveLength(0);
  });

  it('a mention: who, where, the quote, the message before it, and Reply', async () => {
    mocks.activity = [hugoMention];
    await mount();
    expect(host.querySelector('h2')?.textContent).toBe('Waiting on you1');
    const [item] = items();
    expect(item!.textContent).toContain('Hugo Renaudin mentioned you in #rig-marketing');
    expect(item!.querySelector('[data-testid="waiting-quote"]')?.textContent).toBe('@Dylan Bourgeois wdyt');
    expect(item!.querySelector('[data-testid="waiting-context"]')?.textContent).toBe(
      'Right after this message from Hugo: “@claude looks like: mandatory onboarding call”'
    );
    expect(mocks.listMessages).toHaveBeenCalledWith({ bindingId: 'b-mkt', query: { before: '1334', latest: 1 } });
    expect(buttonNamed('Reply')).toBeTruthy();
  });

  it('Reply opens an inline box that sends through the Room, marks it read, then fades and clears', async () => {
    mocks.activity = [hugoMention];
    await mount();
    await act(async () => buttonNamed('Reply')!.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply"]')!;
    expect(input.placeholder).toBe('Reply to Hugo in #rig-marketing');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Yes, the call is a good start');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => buttonNamed('Send')!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.postMessage).toHaveBeenCalledWith({
      bindingId: 'b-mkt',
      body: 'Yes, the call is a good start',
      kind: 'text',
      meta: { replyTo: { id: 'msg-603', authorId: 'u-hugo', label: 'Hugo Renaudin', excerpt: '@Dylan Bourgeois wdyt' } },
    });
    expect(mocks.markRead).toHaveBeenCalledWith({ ids: ['603'] });
    // Done: faded, with a line saying so, and no action left.
    const done = items()[0]!;
    expect(done.dataset.done).toBe('true');
    expect(done.className).toContain('opacity-60');
    expect(done.querySelector('[data-testid="waiting-done"]')?.textContent).toBe('Replied in #rig-marketing.');
    expect(buttonNamed('Reply')).toBeUndefined();
    // Then it clears.
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    vi.useRealTimers();
    expect(items()).toHaveLength(0);
  });

  it('a reply that does not send keeps the item, says so, and lets you try again', async () => {
    mocks.activity = [hugoMention];
    mocks.postMessage.mockResolvedValueOnce({ success: false, error: { message: 'offline' } });
    await mount();
    await act(async () => buttonNamed('Reply')!.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'ok');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => buttonNamed('Send')!.click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Your reply didn't send. Try again.");
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(items()[0]!.dataset.done).toBeUndefined();
  });

  it('an invite: Accept joins and sets the space up here, then says so', async () => {
    mocks.invites = [
      {
        id: 'inv1',
        role: 'member',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        binding: { id: 'b-warm', name: 'warm-island' },
        inviter: { name: 'Ana Silva', email: 'ana@x.co', avatarUrl: null },
      },
    ];
    await mount();
    expect(items()[0]!.textContent).toContain('Ana Silva invited you to #warm-island');
    await act(async () => buttonNamed('Accept')!.click());
    await flush();
    expect(mocks.accept).toHaveBeenCalledWith({ id: 'inv1' });
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b-warm' });
    expect(items()[0]!.querySelector('[data-testid="waiting-done"]')?.textContent).toBe('You joined #warm-island.');
    expect(opened).toEqual([]);
  });

  const waitingRun: RigSpaceStatus = {
    bindingId: 'b-ops',
    running: [
      { runId: 'run-1', agent: 'claude', ownerUserId: 'u-me', startedAt: new Date().toISOString(), activity: 'waiting', title: 'npm test' },
    ],
  };

  it('your agent waiting on approval: Approve answers it from this computer, with the one-off allow', async () => {
    mocks.localEvents = [
      {
        seq: 4,
        kind: 'permission_requested',
        payload: {
          requestId: 'req-1',
          toolCall: { toolCallId: 'tc-1', title: 'Run npm test' },
          options: [
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        },
      },
    ];
    await mount(new Map([['b-ops', waitingRun]]));
    const item = items()[0]!;
    expect(item.textContent).toContain('Your Claude is waiting for your approval in #rig-ops');
    expect(item.querySelector('[data-testid="waiting-quote"]')?.textContent).toBe('Run npm test');
    await act(async () => buttonNamed('Approve')!.click());
    await flush();
    expect(mocks.resolve).toHaveBeenCalledWith({ runId: 'run-1', requestId: 'req-1', optionId: 'once' });
    expect(items()[0]!.querySelector('[data-testid="waiting-done"]')?.textContent).toBe(
      'Approved. Claude is back at work in #rig-ops.'
    );
  });

  it("a run that isn't on this computer: Open takes you to the space", async () => {
    await mount(new Map([['b-ops', waitingRun]]));
    expect(buttonNamed('Approve')).toBeUndefined();
    await act(async () => buttonNamed('Open')!.click());
    expect(opened).toEqual(['/Rig/rig-ops']);
  });
});
