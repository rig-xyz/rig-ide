import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's "Waiting on you": only direct, unread things, drawn as flat rows
 * like the topics under it: the person's face, one muted line saying who
 * and where, their message with mentions as the Room draws them, the
 * message before it as context, and one quiet action. Reply sends inline
 * through the Room's own message shape, Accept joins, Approve answers your
 * own agent from this computer's copy of the run. A done item fades with a
 * line saying so, then folds away. Nothing waiting says so in one line.
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
            self={{ name: 'Dylan Bourgeois', avatarUrl: 'https://img/dylan.png' }}
            avatarOf={({ userId }) => (userId === 'u-hugo' ? 'https://img/hugo.png' : null)}
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
          body: '@claude looks like:\n- mandatory onboarding call',
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

  it('a mention: their face, who and where on one line, the message, the message before it, and Reply', async () => {
    mocks.activity = [hugoMention];
    await mount();
    // The heading reads like "Across your spaces today": the count is quiet mono text, not a pill.
    const heading = host.querySelector('h2')!;
    expect(heading.textContent).toBe('Waiting on you1');
    expect(heading.querySelector('.bg-accent')).toBeNull();
    const [item] = items();
    // A flat row: no card around the list, no bar on the edge.
    expect(host.querySelector('ul')!.className).not.toContain('border');
    expect(item!.innerHTML).not.toContain('before:');
    expect(item!.querySelector('img')?.getAttribute('src')).toBe('https://img/hugo.png');
    expect(item!.querySelector('[data-testid="waiting-meta"]')?.textContent).toBe('Hugo mentioned you · #rig-marketing · 1m');
    expect(item!.querySelector('[data-testid="waiting-quote"]')?.textContent).toBe('@Dylan Bourgeois wdyt');
    // A mention of you, tinted the way the Room tints it.
    const mention = item!.querySelector<HTMLElement>('[data-testid="waiting-mention"]')!;
    expect(mention.textContent).toBe('@Dylan Bourgeois');
    expect(mention.className).toContain('bg-accent-subtle');
    // Context on one line, after a reply glyph, without its list marks or line breaks.
    const context = item!.querySelector<HTMLElement>('[data-testid="waiting-context"]')!;
    expect(context.textContent).toBe('Hugo: @claude looks like: mandatory onboarding call');
    expect(context.querySelector('svg')).toBeTruthy();
    expect(context.querySelector('span')!.className).toContain('truncate');
    expect(mocks.listMessages).toHaveBeenCalledWith({ bindingId: 'b-mkt', query: { before: '1334', latest: 1 } });
    // A quiet button, not a filled one.
    const reply = buttonNamed('Reply')!;
    expect(reply.className).toContain('border-border-hairline');
    expect(reply.className).not.toContain('bg-accent');
  });

  it("someone with no picture: their initials", async () => {
    mocks.activity = [{ ...hugoMention, actor: { kind: 'user', userId: 'u-ana', name: 'Ana Silva', agent: null } }];
    await mount();
    const item = items()[0]!;
    expect(item.querySelector('img')).toBeNull();
    expect(item.textContent).toContain('AS');
    expect(item.querySelector('[data-testid="waiting-meta"]')?.textContent).toBe('Ana mentioned you · #rig-marketing · 1m');
  });

  it('Reply opens an inline box that sends through the Room, marks it read, then fades and clears', async () => {
    mocks.activity = [hugoMention];
    await mount();
    await act(async () => buttonNamed('Reply')!.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply"]')!;
    expect(input.placeholder).toBe('Reply to Hugo in #rig-marketing');
    // Send is the one filled button, inside the box.
    expect(buttonNamed('Send')!.className).toContain('bg-accent');
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
    // Then it folds away, still when motion is reduced, just without the animation.
    expect(done.className).toContain('motion-reduce:transition-none');
    await act(async () => {
      vi.advanceTimersByTime(3_700);
    });
    expect(items()[0]!.className).toContain('grid-rows-[0fr]');
    expect(items()[0]!.className).toContain('opacity-0');
    // Then it clears.
    await act(async () => {
      vi.advanceTimersByTime(300);
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
    expect(items()[0]!.querySelector('[data-testid="waiting-meta"]')?.textContent).toBe('Ana invited you · #warm-island · now');
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
    expect(item.querySelector('[data-testid="waiting-meta"]')?.textContent).toBe('Your Claude needs your approval · #rig-ops · now');
    expect(item.querySelector('[data-testid="waiting-quote"]')?.textContent).toBe('Run npm test');
    // The agent's tile with your face as its owner badge.
    const tile = item.querySelector<HTMLElement>('[data-testid="agent-avatar"]')!;
    expect(tile.dataset.agent).toBe('claude');
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('https://img/dylan.png');
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
