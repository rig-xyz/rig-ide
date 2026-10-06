import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RigInvite, RigMemberList } from '@shared/rig/rig-share';

/**
 * Manage who's in a space (board 26, panel 3): the owner changes a role,
 * removes someone and hands over ownership (each confirmed), and resends or
 * revokes a pending invite; a non-owner sees the same list with no actions.
 * A member's name opens their person card.
 */

const mocks = vi.hoisted(() => ({
  members: vi.fn(),
  listInvites: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  makeOwner: vi.fn(),
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
  people: vi.fn(),
  workspaces: vi.fn(),
  inviteToSpace: vi.fn(),
  forgetPerson: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      share: {
        members: (...a: unknown[]) => mocks.members(...a),
        listInvites: (...a: unknown[]) => mocks.listInvites(...a),
        setMemberRole: (...a: unknown[]) => mocks.setMemberRole(...a),
        removeMember: (...a: unknown[]) => mocks.removeMember(...a),
        makeOwner: (...a: unknown[]) => mocks.makeOwner(...a),
        createInvite: (...a: unknown[]) => mocks.createInvite(...a),
        revokeInvite: (...a: unknown[]) => mocks.revokeInvite(...a),
        people: (...a: unknown[]) => mocks.people(...a),
        collaborators: async () => ({ success: true, data: [] }),
        inviteToSpace: (...a: unknown[]) => mocks.inviteToSpace(...a),
        forgetPerson: (...a: unknown[]) => mocks.forgetPerson(...a),
      },
      account: { workspaces: (...a: unknown[]) => mocks.workspaces(...a) },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { RigSharePopoverContent } from '@renderer/features/rig-share/rig-share-button';

const OWNER_VIEW: RigMemberList = {
  members: [
    { userId: 'usr_me', name: 'Dylan B', email: 'me@example.com', avatarUrl: null, role: 'owner' },
    { userId: 'usr_hugo', name: 'Hugo Renaudin', email: null, avatarUrl: null, role: 'editor' },
  ],
  selfRole: 'owner',
  selfUserId: 'usr_me',
};

function invite(overrides: Partial<RigInvite>): RigInvite {
  return {
    id: 'inv_1',
    emailConstraint: null,
    role: 'editor',
    maxUses: 1,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    label: null,
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    targetUserId: null,
    targetName: null,
    targetAvatarUrl: null,
    ...overrides,
  };
}

const ok = <T,>(data: T) => ({ success: true, data });

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Manage who is in a space', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '340px';
    document.body.appendChild(host);
    root = createRoot(host);
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.members.mockResolvedValue(ok(OWNER_VIEW));
    mocks.listInvites.mockResolvedValue(
      ok({
        invites: [
          invite({
            id: 'inv_jer',
            targetUserId: 'usr_jer',
            targetName: 'Jérémie Rappaz',
            role: 'viewer',
          }),
          invite({ id: 'inv_sam', emailConstraint: 'sam@northwind.io' }),
        ],
      })
    );
    for (const fn of [mocks.setMemberRole, mocks.removeMember, mocks.makeOwner])
      fn.mockResolvedValue(ok({ done: true }));
    mocks.createInvite.mockResolvedValue(
      ok({
        invite: invite({ id: 'inv_new' }),
        url: 'u',
        email: { sent: false, to: null, reason: null },
      })
    );
    mocks.revokeInvite.mockResolvedValue(ok({ revoked: true }));
    mocks.people.mockResolvedValue(
      ok({
        supported: true,
        people: [
          {
            userId: 'usr_hugo',
            clerkUserId: null,
            name: 'Hugo Renaudin',
            avatarUrl: null,
            sharedSpaces: [{ bindingId: 'b_growth', name: 'growth' }],
            lastSharedAt: null,
            viaOrg: false,
          },
        ],
      })
    );
    mocks.workspaces.mockResolvedValue(
      ok([
        { id: 'b_growth', name: 'growth', role: 'owner', kind: 'space' },
        { id: 'b_design', name: 'design', role: 'owner', kind: 'space' },
        { id: 'b_theirs', name: 'theirs', role: 'editor', kind: 'space' },
        { id: 'b_rig', name: 'a-rig', role: 'owner', kind: 'rig' },
      ])
    );
    mocks.inviteToSpace.mockResolvedValue(
      ok({
        invite: invite({ id: 'inv_x' }),
        url: 'u',
        email: { sent: false, to: null, reason: null },
      })
    );
    mocks.forgetPerson.mockResolvedValue(ok({ removed: true }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelectorAll('.rig-people-layer').forEach((el) => el.remove());
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RigSharePopoverContent root="/rigs/growth" name="growth" />
        </QueryClientProvider>
      );
    });
    await flush();
    await flush();
  }

  const byText = (scope: ParentNode, text: string | RegExp) =>
    [
      ...scope.querySelectorAll<HTMLElement>('button,[role="menuitem"],[role="menuitemradio"]'),
    ].find((el) =>
      typeof text === 'string'
        ? el.textContent?.trim() === text
        : text.test(el.textContent?.trim() ?? '')
    )!;
  const click = async (el: HTMLElement) => {
    await act(async () => {
      await userEvent.click(el);
    });
    await flush();
  };
  const openMenu = () =>
    click(host.querySelector<HTMLElement>('[aria-label^="Can edit, change for Hugo"]')!);

  it('offers actions on others, never on the owner’s own row', async () => {
    await render();
    expect(host.querySelector('[aria-label*="change for Dylan"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Can edit, change for Hugo"]')).not.toBeNull();
  });

  it('changes a role straight from the menu', async () => {
    await render();
    await openMenu();
    await click(
      document.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="false"]')!
    );
    expect(mocks.setMemberRole).toHaveBeenCalledWith({
      root: '/rigs/growth',
      userId: 'usr_hugo',
      role: 'viewer',
    });
  });

  it('removes only after a confirm', async () => {
    await render();
    await openMenu();
    await click(byText(document.querySelector('[role="menu"]')!, 'Remove from space'));
    expect(mocks.removeMember).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Remove Hugo Renaudin from growth?');
    await click(byText(host, 'Remove'));
    expect(mocks.removeMember).toHaveBeenCalledWith({ root: '/rigs/growth', userId: 'usr_hugo' });
  });

  it('hands over ownership after a confirm that says you become an editor', async () => {
    await render();
    await openMenu();
    await click(byText(document.querySelector('[role="menu"]')!, 'Make owner'));
    expect(host.textContent).toContain('You become an editor');
    await click(byText(host, 'Make owner'));
    expect(mocks.makeOwner).toHaveBeenCalledWith({ root: '/rigs/growth', userId: 'usr_hugo' });
  });

  it('lists invited people by name, resends to the same person and revokes', async () => {
    await render();
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="pending-invite"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Jérémie Rappaz'),
      expect.stringContaining('sam@northwind.io'),
    ]);
    expect(rows[0].textContent).toContain('Invited 3d ago · Can view');

    await click(byText(rows[0], 'Resend'));
    expect(mocks.createInvite).toHaveBeenCalledWith({
      root: '/rigs/growth',
      email: null,
      targetUserId: 'usr_jer',
      role: 'viewer',
    });
    expect(mocks.revokeInvite).toHaveBeenCalledWith({ root: '/rigs/growth', id: 'inv_jer' });
    expect(mocks.createInvite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revokeInvite.mock.invocationCallOrder[0]
    );

    await click(byText(rows[1], 'Revoke'));
    expect(mocks.revokeInvite).toHaveBeenLastCalledWith({ root: '/rigs/growth', id: 'inv_sam' });
  });

  it('a non-owner sees the list read only', async () => {
    mocks.members.mockResolvedValue(
      ok({ ...OWNER_VIEW, selfRole: 'editor', selfUserId: 'usr_hugo' })
    );
    await render();
    expect(host.textContent).toContain('Hugo Renaudin');
    expect(host.querySelector('[aria-label*=", change for"]')).toBeNull();
    expect(host.querySelector('[data-testid="pending-invite"]')).toBeNull();
    expect(host.querySelector('[data-testid="invite-field"]')).toBeNull();
    expect(mocks.listInvites).not.toHaveBeenCalled();
  });

  it('a name opens the person card: invite them to a space they’re not in, or hide them', async () => {
    await render();
    await click(host.querySelector<HTMLElement>('[aria-label="About Hugo Renaudin"]')!);
    const card = document.querySelector<HTMLElement>('[data-testid="person-card"]')!;
    expect(card.textContent).toContain('In 1 space with you');
    expect(card.querySelector('[data-testid="person-card-shared"]')?.textContent).toBe('#growth');

    await click(byText(card, 'Invite to a space'));
    const picker = document.querySelector<HTMLElement>('[data-testid="person-card-spaces"]')!;
    // Only spaces you own that they're not already in.
    expect(picker.textContent).toContain('#design');
    expect(picker.textContent).not.toContain('#growth');
    expect(picker.textContent).not.toContain('#theirs');
    expect(picker.textContent).not.toContain('a-rig');
    await click(byText(picker, '#design'));
    expect(mocks.inviteToSpace).toHaveBeenCalledWith({
      bindingId: 'b_design',
      targetUserId: 'usr_hugo',
      role: 'editor',
    });
    expect(card.textContent).toContain('Invited to #design');

    await click(card.querySelector<HTMLElement>('[aria-label="More for Hugo Renaudin"]')!);
    await click(byText(document.querySelector('[role="menu"]')!, 'Hide'));
    expect(mocks.forgetPerson).toHaveBeenCalledWith({ userId: 'usr_hugo' });
  });
});
