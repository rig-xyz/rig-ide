import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RigMember, RigMemberList } from '@shared/rig/rig-share';

/**
 * The invite form's collaborator suggestions (lane K, item 1): with the
 * email field focused they used to render in normal flow, so pressing
 * "Send invite" blurred the field, the list vanished, the button jumped up
 * ~42px mid-click and the click landed on nothing. The list is an overlay
 * now — the button never moves — and it hides once the typed email is
 * exactly the one remaining suggestion.
 */

const mocks = vi.hoisted(() => ({
  authStatus: vi.fn(),
  members: vi.fn(),
  listInvites: vi.fn(),
  workspaces: vi.fn(),
  collaborators: vi.fn(),
  createInvite: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: (...args: unknown[]) => mocks.authStatus(...args) },
      share: {
        members: (...args: unknown[]) => mocks.members(...args),
        listInvites: (...args: unknown[]) => mocks.listInvites(...args),
        collaborators: (...args: unknown[]) => mocks.collaborators(...args),
        createInvite: (...args: unknown[]) => mocks.createInvite(...args),
      },
      account: { workspaces: (...args: unknown[]) => mocks.workspaces(...args) },
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
const SAM: RigMember = {
  userId: 'u_sam',
  name: 'Sam Rivera',
  email: 'sam@example.com',
  avatarUrl: null,
  role: 'editor',
};

// This harness doesn't run Tailwind, so utility classes are inert here. The
// handful that decide whether the list is in flow or an overlay are
// reproduced verbatim (same semantics as Tailwind v4's own output) so the
// layout assertions below measure real positioning, not unstyled blocks.
const LAYOUT_UTILITIES = `
  .relative { position: relative; }
  .absolute { position: absolute; }
  .inset-x-0 { left: 0; right: 0; }
  .top-full { top: 100%; }
  .z-10 { z-index: 10; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .w-full { width: 100%; }
  .bg-bg-1 { background: white; }
`;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const style = document.createElement('style');
  style.textContent = LAYOUT_UTILITIES;
  document.head.appendChild(style);
});

describe('InviteSection — collaborator suggestions', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '320px';
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.authStatus.mockReset().mockResolvedValue({ signedIn: true });
    mocks.members.mockReset().mockResolvedValue({ success: true, data: MEMBER_LIST });
    mocks.listInvites.mockReset().mockResolvedValue({ success: true, data: { invites: [] } });
    mocks.workspaces.mockReset().mockResolvedValue({ success: true, data: [{ id: 'b_other' }] });
    mocks.collaborators.mockReset().mockResolvedValue({ success: true, data: [SAM] });
    // What the call returns doesn't matter here — only that the click sent it.
    mocks.createInvite.mockReset().mockResolvedValue({ success: false, error: { message: 'stub' } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function flush() {
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
          <RigSharePopoverContent root="/rigs/growth" name="growth" />
        </QueryClientProvider>
      );
    });
    await flush();
    await flush();
  }

  const emailInput = () => host.querySelector<HTMLInputElement>('input[type="email"]')!;
  const suggestionList = () => host.querySelector('[data-testid="invite-suggestions"]');
  const primaryButton = () =>
    [...host.querySelectorAll('button')].find((b) =>
      ['Send invite', 'Create link'].includes(b.textContent?.trim() ?? '')
    )!;

  it('shows suggestions as an overlay — the Send invite button does not move when the field blurs', async () => {
    await render();
    await act(async () => {
      await userEvent.click(emailInput());
      await userEvent.type(emailInput(), 'sa');
    });
    await flush();

    expect(suggestionList()).toBeTruthy();
    expect(suggestionList()?.textContent).toContain('Sam Rivera');
    const before = primaryButton().getBoundingClientRect().top;

    await act(async () => emailInput().blur());
    expect(suggestionList()).toBeNull();
    expect(primaryButton().getBoundingClientRect().top).toBe(before);
  });

  it('a real pointer click on "Send invite" sends, even while suggestions are showing', async () => {
    await render();
    await act(async () => {
      await userEvent.click(emailInput());
      await userEvent.type(emailInput(), 'sam@example.co');
    });
    await flush();
    expect(suggestionList()).toBeTruthy();

    // The list sits over part of the form — click the button where it
    // actually is, as a user would.
    await act(async () => {
      await userEvent.click(primaryButton());
    });
    await flush();

    expect(mocks.createInvite).toHaveBeenCalledWith({
      root: '/rigs/growth',
      email: 'sam@example.co',
      role: 'editor',
    });
  });

  it('hides the list once the typed email is exactly the only suggestion', async () => {
    await render();
    await act(async () => {
      await userEvent.click(emailInput());
      await userEvent.type(emailInput(), 'SAM@example.com');
    });
    await flush();

    expect(document.activeElement).toBe(emailInput());
    expect(suggestionList()).toBeNull();
  });
});
