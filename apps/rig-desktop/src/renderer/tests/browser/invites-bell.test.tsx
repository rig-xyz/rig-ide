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
            invites: [
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
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { InvitesBell } from '@renderer/features/shell/invites-bell';

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

describe('InvitesBell — Accept', () => {
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
          <InvitesBell onOpenPath={(path) => opened.push(path)} />
        </QueryClientProvider>
      );
    });
    await flush();
    await flush();
    await act(async () => click(host.querySelector('[aria-label^="Invites"]')!));
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
    expect(document.body.querySelector('[role="dialog"][aria-label="Invites"]')).toBeNull();
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
