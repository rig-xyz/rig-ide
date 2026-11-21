import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Invites: the invites addressed to you, each with Accept and Decline, and the row
 * that says there are none (or that they could not be read).
 */

const invite = (id: string, name: string, role: string, inviter: string) => ({
  id,
  role,
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  expiresAt: null,
  binding: { id: `bnd_${id}`, name, kind: 'space' },
  inviter: { name: inviter, email: null, avatarUrl: null },
});

const mocks = vi.hoisted(() => ({
  invites: [] as unknown[],
  listFails: false,
  accept: vi.fn(),
  decline: vi.fn(),
  attach: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: async () => ({ signedIn: true }), logout: vi.fn() },
      account: {
        me: async () => ({
          success: true,
          data: { id: 'usr_1', clerkUserId: 'user_1', email: 'ada@example.com', name: 'Ada', avatarUrl: null, createdAt: '' },
        }),
      },
      share: {
        listMyInvites: async () =>
          mocks.listFails
            ? { success: false, error: { message: 'offline' } }
            : { success: true, data: { invites: mocks.invites } },
        acceptMyInvite: mocks.accept,
        declineMyInvite: mocks.decline,
      },
      join: { attach: mocks.attach },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

import { InvitesPage } from '@renderer/features/settings/pages/invites-page';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Settings › Invites', () => {
  let host: HTMLDivElement;
  let root: Root;
  const opened: string[] = [];
  let closed = 0;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.invites = [];
    mocks.listFails = false;
    mocks.accept.mockReset();
    mocks.decline.mockReset();
    mocks.attach.mockReset();
    opened.length = 0;
    closed = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function settle() {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <InvitesPage onOpenPath={(path) => opened.push(path)} onClose={() => (closed += 1)} />
        </QueryClientProvider>
      );
    });
    await settle();
  }

  const rowOf = (text: string) =>
    [...host.querySelectorAll<HTMLElement>('.flex.items-center.gap-4')].find((row) =>
      row.textContent?.includes(text)
    )!;
  const press = async (row: HTMLElement, label: string) => {
    const button = [...row.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => button.click());
    await settle();
  };

  it('with none, one row says so and names the address they were looked up for', async () => {
    await render();
    const row = host.querySelector<HTMLElement>('[data-settings-row="invites"]')!;
    expect(row.textContent).toContain('No pending invites for ada@example.com.');
    expect(row.querySelector('button')).toBeNull();
  });

  it('says it could not check, never "none", when the read fails', async () => {
    mocks.listFails = true;
    await render();
    const row = host.querySelector<HTMLElement>('[data-settings-row="invites"]')!;
    expect(row.textContent).toContain("Rig couldn't check for invites");
    expect(row.textContent).not.toContain('No pending invites');
  });

  it('lists each invite with who sent it and what it lets you do', async () => {
    mocks.invites = [invite('1', 'launch', 'editor', 'Sam'), invite('2', 'design', 'viewer', 'Alex')];
    await render();
    const text = host.textContent ?? '';
    expect(text).toContain('Invite to #launch');
    expect(text).toContain('Sam invited you 3h ago. You can edit.');
    expect(text).toContain('Alex invited you 3h ago. You can view.');
    // The first carries the search id, so Settings' search for "Invites" lands on them.
    expect(host.querySelector('[data-settings-row="invites"]')!.textContent).toContain('#launch');
  });

  it('Accept joins, sets the space up here, closes Settings and opens it', async () => {
    mocks.invites = [invite('1', 'launch', 'editor', 'Sam')];
    mocks.accept.mockResolvedValue({ success: true, data: {} });
    mocks.attach.mockResolvedValue({ success: true, data: { localPath: '/Users/me/Rig/launch', syncing: false } });
    await render();
    await press(rowOf('Invite to #launch'), 'Accept');
    expect(mocks.accept).toHaveBeenCalledWith({ id: '1' });
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'bnd_1' });
    expect(closed).toBe(1);
    expect(opened).toEqual(['/Users/me/Rig/launch']);
  });

  it('keeps the row with the reason and a retry when joining worked but setting it up here did not', async () => {
    mocks.invites = [invite('1', 'launch', 'editor', 'Sam')];
    mocks.accept.mockResolvedValue({ success: true, data: {} });
    mocks.attach.mockResolvedValue({ success: false, error: { message: 'The disk is full.' } });
    await render();
    await press(rowOf('Invite to #launch'), 'Accept');
    const row = rowOf('Invite to #launch');
    expect(row.textContent).toContain('The disk is full.');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Set up on this computer']);
    expect(opened).toEqual([]);
  });

  it('Decline declines that invite and nothing else', async () => {
    mocks.invites = [invite('1', 'launch', 'editor', 'Sam'), invite('2', 'design', 'viewer', 'Alex')];
    mocks.decline.mockResolvedValue({ success: true, data: undefined });
    await render();
    await press(rowOf('Invite to #design'), 'Decline');
    expect(mocks.decline).toHaveBeenCalledWith({ id: '2' });
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
