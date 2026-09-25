import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RigMemberList } from '@shared/rig/rig-share';

/**
 * Coverage for the `variant: 'compact'` round (Dylan's Share/People polish
 * pass): the space panel's People row wants just the member list plus one
 * "Invite people" pill that expands the SAME invite form in place — never
 * the full-variant's always-visible form, never a navigation to a different
 * surface. This pins both halves: the collapsed shape, and that clicking the
 * pill swaps it for the real form without unmounting the member list.
 */

const mocks = vi.hoisted(() => ({
  authStatus: vi.fn(),
  members: vi.fn(),
  listInvites: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: {
        status: (...args: unknown[]) => mocks.authStatus(...args),
      },
      share: {
        members: (...args: unknown[]) => mocks.members(...args),
        listInvites: (...args: unknown[]) => mocks.listInvites(...args),
      },
      account: {
        workspaces: (...args: unknown[]) => mocks.workspaces(...args),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { RigSharePopoverContent } from '@renderer/features/rig-share/rig-share-button';

const MEMBER_LIST: RigMemberList = {
  members: [
    { userId: 'u_owner', name: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null, role: 'owner' },
  ],
  selfRole: 'owner',
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('RigSharePopoverContent — variant="compact"', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.authStatus.mockReset().mockResolvedValue({ signedIn: true });
    mocks.members.mockReset().mockResolvedValue({ success: true, data: MEMBER_LIST });
    mocks.listInvites.mockReset().mockResolvedValue({ success: true, data: { invites: [] } });
    mocks.workspaces.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function flush() {
    // `authQuery` must settle before `membersQuery` (gated on `enabled:
    // signedIn`) even starts — a couple of microtask ticks isn't enough to
    // carry two sequential queries through React Query's batched dispatch,
    // so wait out a real macrotask turn instead.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render() {
    const queryClient = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RigSharePopoverContent root="/rigs/growth" name="growth" variant="compact" />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  it('shows only the member list and a single Invite people pill — no header, no invite form', async () => {
    await render();

    expect(host.textContent).toContain('Ada Lovelace');
    expect(host.textContent).not.toContain('People on growth');
    expect(host.textContent).not.toContain('Invite someone');
    const buttons = Array.from(host.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).toContain('Invite people');
    // The full invite form's own controls aren't in the DOM yet.
    expect(host.querySelector('input[type="email"]')).toBeNull();
  });

  it('expands the full invite form in place on click — no navigation, member list stays mounted', async () => {
    await render();

    const invitePill = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Invite people'
    );
    expect(invitePill).toBeTruthy();

    await act(async () => {
      invitePill?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(host.querySelector('input[type="email"]')).toBeTruthy();
    expect(host.textContent).toContain('Invite someone');
    expect(host.textContent).toContain('Can edit');
    expect(host.textContent).toContain('Can view');
    // The member list from before is still right there, in the same tree.
    expect(host.textContent).toContain('Ada Lovelace');
    // The pill itself is gone now that the form replaced it.
    expect(
      Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Invite people')
    ).toBe(false);
  });
});
