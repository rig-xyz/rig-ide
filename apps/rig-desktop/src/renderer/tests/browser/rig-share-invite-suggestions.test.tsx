import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { RigMember, RigMemberList, RigPerson } from '@shared/rig/rig-share';

/**
 * Invite by name (board 26, panel 1): typing suggests Your people, picks
 * and full emails become chips, and one Send mints one invite per chip, a
 * person by `targetUserId` and an email by address. The suggestions sit in
 * the flow under the field (at most five, then "Keep typing to see more"),
 * and stay put through a press on Send. Shared spaces count spaces only,
 * never rigs. An older relay without `/v1/me/people` falls back to the
 * members fan-out, and a pick there is an email.
 */

const mocks = vi.hoisted(() => ({
  authStatus: vi.fn(),
  members: vi.fn(),
  listInvites: vi.fn(),
  workspaces: vi.fn(),
  collaborators: vi.fn(),
  people: vi.fn(),
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
        people: (...args: unknown[]) => mocks.people(...args),
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
    { userId: 'usr_owner', name: 'Ada Lovelace', email: 'ada@example.com', avatarUrl: null, role: 'owner' },
    { userId: 'usr_hugo', name: 'Hugo Renaudin', email: null, avatarUrl: null, role: 'editor' },
  ],
  selfRole: 'owner',
  selfUserId: 'usr_owner',
};

function person(userId: string, name: string, extra: Partial<RigPerson> = {}): RigPerson {
  return {
    userId,
    clerkUserId: null,
    name,
    avatarUrl: null,
    sharedSpaces: [{ bindingId: 'b_other', name: 'other' }],
    lastSharedAt: new Date().toISOString(),
    viaOrg: false,
    ...extra,
  };
}

const PEOPLE = [
  person('usr_hugo', 'Hugo Renaudin'), // already a member: never suggested
  person('usr_jeremie', 'Jérémie Rappaz', {
    // A rig you share is never counted.
    sharedSpaces: [
      { bindingId: 'b_other', name: 'other' },
      { bindingId: 'b_rig', name: 'cto-rig' },
    ],
  }),
  person('usr_nat', 'Nat Okafor'), // has a pending invite: never suggested
  person('usr_jean', 'Jean Dubois', { sharedSpaces: [], viaOrg: true }),
];

const SAM: RigMember = { userId: 'u_sam', name: 'Sam Rivera', email: 'sam@example.com', avatarUrl: null, role: 'editor' };

// This harness doesn't run Tailwind; the utilities that decide the layout
// are reproduced so layout assertions measure real positions.
const LAYOUT_UTILITIES = `
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .h-9 { height: 36px; }
`;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const style = document.createElement('style');
  style.textContent = LAYOUT_UTILITIES;
  document.head.appendChild(style);
});

function minted(id: string, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      invite: {
        id,
        role: 'editor',
        emailConstraint: null,
        maxUses: null,
        useCount: 0,
        expiresAt: null,
        revokedAt: null,
        label: null,
        createdAt: '',
        ...extra,
      },
      url: `https://userig.xyz/join/${id}`,
      email: { sent: Boolean(extra.emailConstraint), to: (extra.emailConstraint as string) ?? null, reason: null },
    },
  };
}

describe('InviteByName', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '320px';
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.authStatus.mockReset().mockResolvedValue({ signedIn: true });
    mocks.members.mockReset().mockResolvedValue({ success: true, data: MEMBER_LIST });
    mocks.listInvites.mockReset().mockResolvedValue({
      success: true,
      data: {
        invites: [
          {
            id: 'inv_nat',
            emailConstraint: null,
            role: 'editor',
            maxUses: 1,
            useCount: 0,
            expiresAt: null,
            revokedAt: null,
            label: null,
            createdAt: new Date().toISOString(),
            targetUserId: 'usr_nat',
            targetName: 'Nat Okafor',
            targetAvatarUrl: null,
          },
        ],
      },
    });
    mocks.workspaces.mockReset().mockResolvedValue({
      success: true,
      data: [
        { id: 'b_other', name: 'other', role: 'owner', kind: 'space' },
        { id: 'b_rig', name: 'cto-rig', role: 'owner', kind: 'rig' },
      ],
    });
    mocks.collaborators.mockReset().mockResolvedValue({ success: true, data: [SAM] });
    mocks.people.mockReset().mockResolvedValue({ success: true, data: { supported: true, people: PEOPLE } });
    mocks.createInvite
      .mockReset()
      .mockImplementation(async (args: { email: string | null; targetUserId: string | null }) =>
        minted(`inv_${args.targetUserId ?? args.email ?? 'link'}`, {
          targetUserId: args.targetUserId,
          emailConstraint: args.email,
        })
      );
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

  const field = () => host.querySelector<HTMLInputElement>('[data-testid="invite-field"]')!;
  const list = () => host.querySelector('[data-testid="invite-suggestions"]');
  const chips = () =>
    [...host.querySelectorAll('[data-testid="invite-chip"] button')].map((b) =>
      b.getAttribute('aria-label')?.replace(/^Remove /, '')
    );
  const button = (label: RegExp) => [...host.querySelectorAll('button')].find((b) => label.test(b.textContent?.trim() ?? ''))!;
  const sendButton = () => button(/^Send/);
  const option = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((b) => b.textContent?.includes(name))!;

  it('suggests Your people, organization after, minus members and pending invites', async () => {
    await render();
    await act(async () => {
      await userEvent.click(field());
    });
    await flush();

    const text = list()?.textContent ?? '';
    expect(text).toContain('Your people');
    expect(text).toContain('Jérémie Rappaz');
    // Jérémie shares a space and a rig with you: only the space counts.
    expect(text).toContain('1 space together · today');
    expect(text).not.toContain('2 spaces together');
    expect(text).toContain('Your organization');
    expect(text).toContain('Jean Dubois');
    expect(text.indexOf('Jérémie')).toBeLessThan(text.indexOf('Jean'));
    expect(text).not.toContain('Hugo Renaudin');
    expect(text).not.toContain('Nat Okafor');
  });

  it('turns a pick and an email into chips, and sends one invite per chip', async () => {
    await render();
    await act(async () => {
      await userEvent.click(field());
      await userEvent.type(field(), 'jer');
    });
    await flush();
    expect(list()?.textContent).toContain('Jérémie Rappaz');

    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await act(async () => {
      await userEvent.type(field(), 'sam@northwind.io,');
    });
    await flush();
    expect(chips()).toEqual(['Jérémie Rappaz', 'sam@northwind.io']);
    expect(sendButton().textContent).toContain('Send 2 invites');

    await act(async () => {
      await userEvent.click(button(/^Can view$/));
    });
    await act(async () => {
      await userEvent.click(sendButton());
    });
    await flush();

    expect(mocks.createInvite.mock.calls.map((c) => c[0])).toEqual([
      { root: '/rigs/growth', email: null, targetUserId: 'usr_jeremie', role: 'viewer' },
      { root: '/rigs/growth', email: 'sam@northwind.io', targetUserId: null, role: 'viewer' },
    ]);
    expect(chips()).toEqual([]);
    const sent = host.querySelector('[data-testid="sent-invites"]')?.textContent ?? '';
    expect(sent).toContain('Invited Jérémie Rappaz.');
    expect(sent).toContain('Invite emailed to sam@northwind.io.');
  });

  it('refuses a name it can’t find, and never mints an open link from the field', async () => {
    await render();
    await act(async () => {
      await userEvent.click(field());
      await userEvent.type(field(), 'Zed');
    });
    await flush();
    expect(list()?.textContent).toContain('Invite by email');
    // Nothing to send yet.
    expect(sendButton().disabled).toBe(true);

    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await flush();
    expect(host.textContent).toContain('type a full email address');
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('Copy link is the one way to an open link', async () => {
    await render();
    await act(async () => {
      await userEvent.click(button(/^Copy link$/));
    });
    await flush();
    expect(mocks.createInvite).toHaveBeenCalledWith({
      root: '/rigs/growth',
      email: null,
      targetUserId: null,
      role: 'editor',
    });
    expect(host.textContent).toContain('Anyone with this link can join');
  });

  it('puts invite first and the people in the space after it', async () => {
    await render();
    const invite = host.querySelector('[data-testid="invite-by-name"]')!;
    const members = host.querySelector('[data-testid="member-list"]')!;
    expect(invite.textContent).toContain('Invite to growth');
    expect(invite.compareDocumentPosition(members) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector('[data-testid="members-label"]')?.textContent).toBe('People · 2');
  });

  it('shows the suggestions in the flow, at most five, then asks to keep typing', async () => {
    mocks.people.mockResolvedValue({
      success: true,
      data: {
        supported: true,
        people: Array.from({ length: 8 }, (_, i) => person(`usr_p${i}`, `Pat ${i}`)),
      },
    });
    await render();
    await act(async () => {
      await userEvent.click(field());
    });
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(5);
    expect(list()?.textContent).toContain('Keep typing to see more');
    // In the flow: the list sits between the field and the Send row.
    const listBox = list()!.getBoundingClientRect();
    expect(listBox.top).toBeGreaterThanOrEqual(field().getBoundingClientRect().bottom);
    expect(sendButton().getBoundingClientRect().top).toBeGreaterThanOrEqual(listBox.bottom);
    expect(getComputedStyle(list()!).position).toBe('static');
  });

  it('a press on Send while the list shows still sends; the list stays while focus is in the section', async () => {
    await render();
    await act(async () => {
      await userEvent.click(field());
      await userEvent.type(field(), 'jer');
      await userEvent.keyboard('{Enter}');
    });
    await flush();
    expect(list()).toBeTruthy();
    await act(async () => {
      await userEvent.click(sendButton());
    });
    await flush();
    expect(mocks.createInvite).toHaveBeenCalledWith({
      root: '/rigs/growth',
      email: null,
      targetUserId: 'usr_jeremie',
      role: 'editor',
    });
    // Sent: the suggestions step aside.
    expect(list()).toBeNull();

    await act(async () => {
      await userEvent.click(field());
    });
    await flush();
    expect(list()).toBeTruthy();
    // Moving within the section (the role control) keeps it open.
    await act(async () => {
      await userEvent.click(button(/^Can view$/));
    });
    await flush();
    expect(list()).toBeTruthy();
    // Leaving the section closes it.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await flush();
    expect(list()).toBeNull();
  });

  it('falls back to the members fan-out on an older relay, and a pick there is an email', async () => {
    mocks.people.mockResolvedValue({ success: true, data: { supported: false, people: [] } });
    await render();
    await act(async () => {
      await userEvent.click(field());
      await userEvent.type(field(), 'sa');
    });
    await flush();
    await flush();
    expect(list()?.textContent).toContain('Sam Rivera');

    await act(async () => {
      option('Sam Rivera').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(chips()).toEqual(['sam@example.com']);

    await act(async () => {
      await userEvent.click(sendButton());
    });
    await flush();
    expect(mocks.createInvite).toHaveBeenCalledWith({
      root: '/rigs/growth',
      email: 'sam@example.com',
      targetUserId: null,
      role: 'editor',
    });
  });
});
