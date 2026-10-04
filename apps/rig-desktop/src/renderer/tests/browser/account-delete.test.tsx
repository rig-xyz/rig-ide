import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Account › Delete account: the row, the confirm dialog that
 * states what happens and only enables its button once you type your email
 * or "delete", and what the page shows after. `Dialog` (Base UI) portals to
 * `document.body`, so assertions read off `document`.
 */

const mocks = vi.hoisted(() => ({
  signedIn: true,
  user: {
    id: 'usr_1',
    clerkUserId: 'user_1',
    email: 'ada@example.com',
    name: 'Ada',
    avatarUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
  } as Record<string, unknown>,
  deleteAccount: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: {
        status: async () => ({ signedIn: mocks.signedIn }),
        deleteAccount: mocks.deleteAccount,
        logout: vi.fn(async () => ({ success: true, data: undefined })),
      },
      account: { me: async () => ({ success: true, data: mocks.user }) },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));

import { AccountPage } from '@renderer/features/settings/pages/account-page';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Delete account', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    mocks.signedIn = true;
    mocks.user = { ...mocks.user, deletionScheduledAt: undefined };
    mocks.deleteAccount.mockReset();
    mocks.toast.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AccountPage />
        </QueryClientProvider>
      );
    });
    await settle();
    await settle();
  }

  const row = () => document.querySelector<HTMLElement>('[data-settings-row="delete-account"]');
  const openButton = () =>
    Array.from(row()?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Delete account…'
    )!;
  const confirmInput = () =>
    document.getElementById('delete-account-confirm') as HTMLInputElement | null;
  const submitButton = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')).find((b) =>
      /Delete account|Deleting/.test(b.textContent ?? '')
    )!;

  async function type(text: string) {
    const input = confirmInput()!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('sits last on the page, danger styled, with its one sentence', async () => {
    await render();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-row]')).map(
      (r) => r.dataset.settingsRow
    );
    expect(rows).toEqual(['signed-in', 'sign-out', 'delete-account']);
    expect(row()!.textContent).toContain(
      'Deletes your account after 7 days. Signing back in before then cancels it.'
    );
    expect(row()!.querySelector('.text-danger')?.textContent).toBe('Delete account');
    expect(openButton()).toBeTruthy();
  });

  it('says plainly what happens, and only enables the button for the email or "delete"', async () => {
    await render();
    await act(async () => openButton().click());
    await settle();
    const consequences = document.querySelector(
      '[data-testid="delete-account-consequences"]'
    )!.textContent!;
    expect(consequences).toContain('Spaces you share are handed to another member.');
    expect(consequences).toContain('Spaces only you are in are deleted.');
    expect(consequences).toContain(
      'Your messages in shared spaces stay and show as Former member.'
    );
    expect(consequences).toContain('Your files on this computer are not touched.');
    expect(consequences).toContain(
      'Spaces handed to someone else stay with them if you come back.'
    );
    expect(document.body.textContent).toContain('Type ada@example.com or delete to confirm.');

    expect(submitButton().disabled).toBe(true);
    await type('dele');
    expect(submitButton().disabled).toBe(true);
    await type('ADA@example.com ');
    expect(submitButton().disabled).toBe(false);
    await type('Delete');
    expect(submitButton().disabled).toBe(false);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('on success, signs out like Sign out and says when the account goes', async () => {
    mocks.deleteAccount.mockImplementation(async () => {
      mocks.signedIn = false;
      return {
        success: true,
        data: {
          deletionScheduledAt: '2026-10-11T12:00:00.000Z',
          alreadyScheduled: false,
          signedOut: true,
        },
      };
    });
    await render();
    await act(async () => openButton().click());
    await settle();
    await type('delete');
    await act(async () => submitButton().click());
    await settle();
    await settle();

    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    expect(confirmInput()).toBeNull();
    const date = new Date('2026-10-11T12:00:00.000Z').toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `Your account will be deleted on ${date}.`,
        description: 'Sign in again before then to keep it.',
      })
    );
    // Signed out now, and the page still says when.
    expect(document.body.textContent).toContain('Not signed in');
    expect(row()!.textContent).toContain(`Your account will be deleted on ${date}.`);
    expect(openButton()).toBeUndefined();
  });

  it('keeps the dialog open with the reason when the relay refuses', async () => {
    mocks.deleteAccount.mockResolvedValue({
      success: false,
      error: {
        kind: 'relay',
        message: "Could not delete your account. Rig can't reach the server right now.",
      },
    });
    await render();
    await act(async () => openButton().click());
    await settle();
    await type('delete');
    await act(async () => submitButton().click());
    await settle();
    expect(confirmInput()).toBeTruthy();
    expect(document.body.textContent).toContain("Rig can't reach the server right now.");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('shows the scheduled date instead of the button when the account already has one', async () => {
    mocks.user = { ...mocks.user, deletionScheduledAt: '2026-10-11T12:00:00.000Z' };
    await render();
    expect(openButton()).toBeUndefined();
    expect(row()!.textContent).toContain('Account deletion scheduled');
    expect(row()!.textContent).toContain('Sign in again before then to keep it.');
  });
});
