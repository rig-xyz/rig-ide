import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first-run Home for someone who came for an invite: "Join #name" from
 * the inviter is the big button, every invite is listed, Start fresh is a
 * link; signed out, Sign in on its own makes nothing.
 */

const ok = (data: unknown) => ({ success: true as const, data });

const mocks = vi.hoisted(() => ({
  signedIn: true,
  invites: [] as unknown[],
  start: vi.fn(),
  create: vi.fn(),
  accept: vi.fn(),
  attach: vi.fn(),
  login: vi.fn(),
  acceptLink: vi.fn(),
}));

const invite = (id: string, name: string, inviter: string, kind: 'space' | 'rig' = 'space') => ({
  id,
  role: 'editor',
  createdAt: '2026-10-08T10:00:00Z',
  expiresAt: null,
  binding: { id: `b_${id}`, name, kind },
  inviter: { name: inviter, email: null, avatarUrl: null },
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => ({ success: true }) },
    agents: {
      list: async () => [
        { id: 'claude', name: 'Claude', icon: null, status: 'available', version: '2.1.160', installations: [], used: { kind: 'auto' }, latestVersion: null, capabilities: { auth: { kind: 'none' } } },
      ],
      probeAll: async () => undefined,
      listMetadata: async () => [],
    },
    rig: {
      auth: {
        status: async () => ({ signedIn: mocks.signedIn }),
        login: (...args: unknown[]) => mocks.login(...args),
        awaitLogin: () => new Promise(() => {}),
        cancel: async () => undefined,
      },
      agentSignIn: { needed: async () => [] },
      account: { me: async () => ok({ id: 'u1', email: 'me@example.com', name: 'Me' }), workspaces: async () => ok([]) },
      offline: { homeSnapshot: async () => ({ accountId: 'u1', workspaces: null, roomSavedAt: {} }) },
      recent: { recentRigs: async () => [], resolveLocalPaths: async () => ({}), backfillAccountId: async () => undefined },
      sessions: { listRecentAcrossRigs: async () => [] },
      share: {
        listMyInvites: async () => ok({ invites: mocks.invites }),
        collaborators: async () => ok([]),
        acceptMyInvite: (...args: unknown[]) => mocks.accept(...args),
        acceptInviteLink: (...args: unknown[]) => mocks.acceptLink(...args),
      },
      join: { attach: (...args: unknown[]) => mocks.attach(...args) },
      create: { create: (...args: unknown[]) => mocks.create(...args) },
      spaceStatus: { get: async () => ok([]) },
      spaceSetup: { start: (...args: unknown[]) => mocks.start(...args), list: async () => [] },
      pulse: { get: async () => ({ success: false, error: { kind: 'relay', message: 'off' } }) },
      settings: {
        get: async () => ({ spacesEnabled: true, showPlainRigs: false, rigsRailView: { filter: 'all', sort: 'recent' }, hiddenByRig: {} }),
        set: async () => {},
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { Home } from '@renderer/features/home/home';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('first-run Home with an invite', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: Array<{ path: string; kind?: string }>;

  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
  const named = (text: string) => buttons().find((b) => b.textContent?.trim() === text);

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
    mocks.signedIn = true;
    mocks.invites = [];
    mocks.start.mockReset();
    mocks.create.mockReset();
    mocks.accept.mockReset().mockResolvedValue(ok({ bindingId: 'b_1', becameMember: true }));
    mocks.attach.mockReset().mockResolvedValue(ok({ localPath: '/Rig/launch', syncing: true }));
    mocks.acceptLink.mockReset().mockResolvedValue(ok({ bindingId: 'b_9', spaceName: 'growth', kind: 'space', becameMember: true }));
    mocks.login.mockReset().mockResolvedValue(ok({ url: 'https://clerk.example/sign-in' }));
    opened = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('makes Join #name the big button, which accepts and opens the space', async () => {
    mocks.invites = [invite('1', 'launch', 'Ana')];
    await mount();
    expect(host.textContent).toContain('Ana invited you to #launch');
    const big = host.querySelector<HTMLButtonElement>('[data-testid="invite-welcome-join"]')!;
    expect(big.textContent).toBe('Join #launch');
    expect(big.className).toContain('welcome-cta');
    expect(buttons().filter((b) => b.className.includes('welcome-cta'))).toHaveLength(1);
    expect(named('Start fresh instead')).toBeTruthy();

    await act(async () => big.click());
    await flush();
    expect(mocks.accept).toHaveBeenCalledWith({ id: '1' });
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b_1', name: 'launch' });
    expect(opened).toEqual([{ path: '/Rig/launch', kind: 'space' }]);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('lists every invite, a plain rig without #', async () => {
    mocks.invites = [invite('1', 'launch', 'Ana'), invite('2', 'hiring', 'Sam'), invite('3', 'notes', 'Lee', 'rig')];
    await mount();
    const more = host.querySelector('[data-testid="invite-welcome-more"]')!;
    expect(more.textContent).toContain('Sam invited you to #hiring');
    expect(more.textContent).toContain('Lee invited you to notes');
  });

  it('says so when the space was joined but could not be set up, with Set up again', async () => {
    mocks.invites = [invite('1', 'launch', 'Ana')];
    mocks.attach.mockResolvedValueOnce({ success: false, error: { message: 'disk full' } });
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="invite-welcome-join"]')!.click());
    await flush();
    expect(host.textContent).toContain("You joined #launch, but it couldn't be set up here.");
    const again = host.querySelector<HTMLButtonElement>('[data-testid="invite-welcome-join"]')!;
    expect(again.textContent).toBe('Set up again');
    await act(async () => again.click());
    await flush();
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(opened).toHaveLength(1);
  });

  it('signed out, Sign in on its own makes no space', async () => {
    mocks.signedIn = false;
    await mount();
    const signIn = host.querySelector<HTMLButtonElement>('[data-testid="welcome-sign-in"]')!;
    expect(signIn).toBeTruthy();
    await act(async () => signIn.click());
    await flush();
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="sign-in-waiting"]')).toBeTruthy();
  });

  it('shows the invite link field without hover, and joins with a pasted link', async () => {
    await mount();
    const field = host.querySelector<HTMLFormElement>('[data-testid="invite-link-field"]')!;
    expect(field.textContent).toContain('Have an invite link?');
    const input = field.querySelector('input')!;
    expect(input.offsetParent).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'https://userig.xyz/join/tap_inv_Ab3-_x9QwErTyUiOpAsDfGhJkLzXcVbN');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => field.requestSubmit());
    await flush();
    expect(mocks.acceptLink).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b_9', name: 'growth' });
    expect(opened).toEqual([{ path: '/Rig/launch', kind: 'space' }]);
  });

  it('shows the invite link field beside an invite too', async () => {
    mocks.invites = [invite('1', 'launch', 'Ana')];
    await mount();
    expect(host.querySelector('[data-testid="invite-welcome"] [data-testid="invite-link-field"]')).toBeTruthy();
  });
});
