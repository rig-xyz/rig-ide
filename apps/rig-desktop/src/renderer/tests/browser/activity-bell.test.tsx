import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lane J: the bell's Accept is one step — accept, attach, open the space,
 * close the popover — like Home's `PendingInviteInline`. "Set up locally"
 * only appears as the retry when the attach half fails after the accept.
 */

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  attach: vi.fn(),
  activity: [] as unknown[],
  away: [] as string[],
  invites: true,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      account: { me: async () => ({ success: true, data: { id: 'u-sam', email: 'sam@play.local' } }) },
      share: {
        listMyInvites: async () => ({
          success: true,
          data: {
            invites: !mocks.invites ? [] : [
              {
                id: 'inv1',
                role: 'member',
                createdAt: new Date().toISOString(),
                expiresAt: null,
                binding: { id: 'b-gentle', name: 'gentle-island' },
                inviter: { name: 'Dylan', email: 'dylan@play.local', avatarUrl: null },
              },
            ],
          },
        }),
        acceptMyInvite: (...args: unknown[]) => mocks.accept(...args),
        declineMyInvite: async () => ({ success: true, data: null }),
      },
      join: { attach: (...args: unknown[]) => mocks.attach(...args) },
      notifications: {
        summary: async () => ({ spaces: [], invitesUnread: 0, directUnreadTotal: 0 }),
        activity: async () => ({ success: true, data: mocks.activity }),
        arrivedWhileAway: async () => mocks.away,
        markRead: async () => ({ success: true, data: undefined }),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { ActivityBell } from '@renderer/features/notifications/activity-bell';
import { row } from '@shared/rig/notification-fixture';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ActivityBell — invite Accept', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    opened = [];
    mocks.accept.mockReset().mockResolvedValue({ success: true, data: { bindingId: 'b-gentle', becameMember: true } });
    mocks.attach.mockReset().mockResolvedValue({
      success: true,
      data: { localPath: '/Rig/gentle-island', syncing: true },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ActivityBell onOpenPath={(path) => opened.push(path)} onOpenTarget={() => {}} />
        </QueryClientProvider>
      );
    });
    await flush();
    await flush();
    await act(async () => click(host.querySelector('[aria-label^="Activity"]')!));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('accepts, sets the space up and opens it in one click, closing the popover', async () => {
    expect(document.body.textContent).toContain('gentle-island');
    await act(async () => click(buttonNamed('Accept')!));
    await flush();

    expect(mocks.accept).toHaveBeenCalledWith({ id: 'inv1' });
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b-gentle' });
    expect(opened).toEqual(['/Rig/gentle-island']);
    expect(document.body.querySelector('[role="dialog"][aria-label="Activity"]')).toBeNull();
    expect(buttonNamed('Set up locally')).toBeUndefined();
  });

  it('shows one "Joining…" label while it works', async () => {
    let resolveAccept!: (v: unknown) => void;
    mocks.accept.mockReturnValue(new Promise((resolve) => (resolveAccept = resolve)));
    await act(async () => click(buttonNamed('Accept')!));
    expect(buttonNamed('Joining…')).toBeTruthy();
    await act(async () => resolveAccept({ success: true, data: { bindingId: 'b-gentle', becameMember: true } }));
    await flush();
  });

  it('keeps a "Set up locally" retry with the error when the attach fails after the accept', async () => {
    mocks.attach.mockResolvedValueOnce({ success: false, error: { message: 'Disk full' } });
    await act(async () => click(buttonNamed('Accept')!));
    await flush();

    expect(opened).toEqual([]);
    expect(document.body.textContent).toContain('Disk full');
    const retry = buttonNamed('Set up locally');
    expect(retry).toBeTruthy();

    await act(async () => click(retry!));
    await flush();
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(['/Rig/gentle-island']);
  });

  it('does not attach when the accept itself fails', async () => {
    mocks.accept.mockResolvedValueOnce({ success: false, error: { message: 'Invite expired' } });
    await act(async () => click(buttonNamed('Accept')!));
    await flush();

    expect(mocks.attach).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Invite expired');
    expect(buttonNamed('Accept')).toBeTruthy();
  });
});

describe('ActivityBell — only what is for you, by space', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.invites = false;
    const mine = { kind: 'agent' as const, userId: 'u-sam', name: 'Sam', agent: 'claude' as const };
    mocks.activity = [
      row({ id: '9', type: 'mention', tier: 'direct', bindingId: 'b-mkt', spaceName: 'rig-marketing', title: 'Hugo mentioned you in rig-marketing' }),
      row({ id: '8', type: 'message', bindingId: 'b-mkt', spaceName: 'rig-marketing' }),
      row({ id: '7', type: 'agent_finished', tier: 'direct', bindingId: 'b-ops', spaceName: 'rig-ops', actor: mine, title: 'Your Claude finished in rig-ops' }),
      row({ id: '6', type: 'agent_finished', tier: 'direct', bindingId: 'b-ops', spaceName: 'rig-ops', actor: mine, title: 'Your Claude finished while away' }),
      row({ id: '5', type: 'comment', bindingId: 'b-mkt', spaceName: 'rig-marketing', fileAuthorUserId: 'u-hugo' }),
      row({ id: '4', type: 'comment', bindingId: 'b-fkn', spaceName: 'rig-fkn-sht', fileAuthorUserId: 'u-sam', title: 'Raf commented on plan.md', readAt: '2026-10-07T00:00:00Z' }),
    ];
    mocks.away = ['6'];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ActivityBell onOpenPath={() => {}} onOpenTarget={() => {}} />
        </QueryClientProvider>
      );
    });
    await flush();
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    mocks.invites = true;
    mocks.activity = [];
    mocks.away = [];
  });

  it('counts only the unread it keeps, lists them by space, and says what it left out', async () => {
    const trigger = host.querySelector('[aria-label^="Activity"]')!;
    expect(trigger.getAttribute('aria-label')).toBe('Activity (2)');
    await act(async () => click(trigger));
    const groups = [...document.body.querySelectorAll<HTMLElement>('[data-testid="activity-group"]')];
    expect(groups.map((g) => g.querySelector('p')?.textContent)).toEqual(['#rig-marketing', '#rig-ops', '#rig-fkn-sht']);
    expect(groups[0]!.textContent).toContain('Hugo mentioned you in rig-marketing');
    expect(groups[1]!.textContent).toContain('Your Claude finished while away');
    expect(groups[1]!.textContent).not.toContain('Your Claude finished in rig-ops');
    expect(groups[2]!.textContent).toContain('Raf commented on plan.md');
    expect(document.body.querySelector('[data-testid="activity-left-out"]')?.textContent).toBe(
      "3 more are left out: 1 run of your own agents finishing while you were here, 1 room message and 1 comment on a file that isn't yours. They stay in each space."
    );
  });
});
