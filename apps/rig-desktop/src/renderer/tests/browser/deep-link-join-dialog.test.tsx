import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `rig://join/<secret>` confirm: a link (drained at mount, or live on
 * the event channel) opens "Join #space?" from the invite's preview, and
 * nothing is accepted until Join. Join runs accept → attach → open; errors
 * stay in the dialog until dismissed; without a sign-in it offers the app's
 * sign-in and resumes the join once that finishes.
 */

const mocks = vi.hoisted(() => ({
  consumePending: vi.fn(),
  release: vi.fn(),
  preview: vi.fn(),
  accept: vi.fn(),
  attach: vi.fn(),
  login: vi.fn(),
  awaitLogin: vi.fn(),
  cancelLogin: vi.fn(),
  logout: vi.fn(),
  listener: null as ((payload: { link: string }) => void) | null,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => ({ success: true }) },
    rig: {
      deepLink: {
        consumePending: (...args: unknown[]) => mocks.consumePending(...args),
        release: (...args: unknown[]) => mocks.release(...args),
      },
      share: {
        previewInviteLink: (...args: unknown[]) => mocks.preview(...args),
        acceptInviteLink: (...args: unknown[]) => mocks.accept(...args),
      },
      join: { attach: (...args: unknown[]) => mocks.attach(...args) },
      auth: {
        login: (...args: unknown[]) => mocks.login(...args),
        awaitLogin: (...args: unknown[]) => mocks.awaitLogin(...args),
        cancel: (...args: unknown[]) => mocks.cancelLogin(...args),
        logout: (...args: unknown[]) => mocks.logout(...args),
      },
    },
  },
  events: {
    on: vi.fn((_channel: unknown, cb: (payload: { link: string }) => void) => {
      mocks.listener = cb;
      return () => {
        mocks.listener = null;
      };
    }),
  },
}));

import { DeepLinkJoinDialog } from '@renderer/features/deep-link/deep-link-join-dialog';

const SECRET = 'tap_inv_Ab3-_x9QwErTyUiOpAsDfGhJkLzXcVbN';
const LINK = `https://userig.xyz/join/${SECRET}`;

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-testid="deep-link-join"]');
const buttonNamed = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('DeepLinkJoinDialog', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];
  let openedKinds: Array<string | undefined>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    opened = [];
    openedKinds = [];
    mocks.listener = null;
    mocks.consumePending.mockReset().mockResolvedValue(null);
    mocks.release.mockReset().mockResolvedValue(undefined);
    mocks.preview
      .mockReset()
      .mockResolvedValue({ success: true, data: { spaceName: 'growth', inviterName: 'Ada' } });
    mocks.accept
      .mockReset()
      .mockResolvedValue({
        success: true,
        data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true },
      });
    mocks.attach
      .mockReset()
      .mockResolvedValue({ success: true, data: { localPath: '/Rig/growth', syncing: true } });
    mocks.login.mockReset().mockResolvedValue({ success: true, data: { url: null } });
    mocks.awaitLogin.mockReset().mockResolvedValue({ success: true, data: null });
    mocks.cancelLogin.mockReset().mockResolvedValue(undefined);
    mocks.logout.mockReset().mockResolvedValue({ success: true, data: undefined });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <DeepLinkJoinDialog
            onOpenPath={(path, kind) => {
              opened.push(path);
              openedKinds.push(kind);
            }}
          />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  it('shows nothing until a link arrives', async () => {
    await render();
    expect(dialog()).toBeNull();
    expect(mocks.consumePending).toHaveBeenCalledTimes(1);
  });

  it('shows a link that arrived before mount with the preview, and joins nothing until Join', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    await render();

    expect(dialog()?.dataset.phase).toBe('ready');
    expect(dialog()?.textContent).toContain('Join #growth?');
    expect(dialog()?.textContent).toContain('Invited by Ada');
    expect(dialog()?.textContent).not.toContain(SECRET);
    expect(mocks.preview).toHaveBeenCalledWith({ link: LINK });
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('names a plain rig without # and opens it as a rig, not a space', async () => {
    mocks.preview.mockResolvedValue({ success: true, data: { spaceName: 'notes', inviterName: 'Ada', emailHint: null, kind: 'rig' } });
    mocks.accept.mockResolvedValue({ success: true, data: { bindingId: 'b_2', spaceName: 'notes', kind: 'rig', becameMember: true } });
    mocks.consumePending.mockResolvedValue({ link: LINK });
    await render();
    expect(dialog()?.textContent).toContain('Join notes?');
    await act(async () => click(buttonNamed('Join')!));
    await flush();
    expect(openedKinds).toEqual([undefined]);
  });

  it('opens a space as a space', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    await render();
    await act(async () => click(buttonNamed('Join')!));
    await flush();
    expect(openedKinds).toEqual(['space']);
  });

  it('shows a live link, then Join runs accept → attach → open and closes', async () => {
    await render();
    await act(async () => mocks.listener!({ link: LINK }));
    await flush();
    expect(dialog()?.dataset.phase).toBe('ready');

    const accept = deferred<unknown>();
    mocks.accept.mockReturnValueOnce(accept.promise);
    await act(async () => click(buttonNamed('Join')!));
    expect(dialog()?.dataset.phase).toBe('joining');
    expect(buttonNamed('Joining…')?.disabled).toBe(true);
    expect(buttonNamed('Not now')?.disabled).toBe(true);

    await act(async () =>
      accept.resolve({
        success: true,
        data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true },
      })
    );
    await flush();

    expect(mocks.accept).toHaveBeenCalledWith({ link: LINK });
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b_1', name: 'growth' });
    expect(opened).toEqual(['/Rig/growth']);
    await flush();
    expect(dialog()).toBeNull();
  });

  it('Not now dismisses without joining', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    await render();

    await act(async () => click(buttonNamed('Not now')!));
    await flush();

    expect(dialog()).toBeNull();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('shows a preview error (expired) with only a way to dismiss', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    mocks.preview.mockResolvedValue({
      success: false,
      error: { kind: 'expired', message: 'This invite link has expired — ask for a new one.' },
    });
    await render();

    expect(dialog()?.dataset.phase).toBe('error');
    expect(dialog()?.textContent).toContain('This invite link has expired');
    expect(buttonNamed('Join')).toBeUndefined();

    await act(async () => click(buttonNamed('Close')!));
    await flush();
    expect(dialog()).toBeNull();
  });

  it('shows an accept error (already used) in the dialog', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    mocks.accept.mockResolvedValue({
      success: false,
      error: {
        kind: 'used',
        message: 'This invite link has already been used — ask for a new one.',
      },
    });
    await render();

    await act(async () => click(buttonNamed('Join')!));
    await flush();

    expect(dialog()?.dataset.phase).toBe('error');
    expect(dialog()?.textContent).toContain('already been used');
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it('names who an email invite is for, then on the wrong account names both and signs in with another', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    mocks.preview.mockResolvedValue({
      success: true,
      data: { spaceName: 'growth', inviterName: 'Ada', emailHint: 'h•••@gmail.com' },
    });
    mocks.accept
      .mockResolvedValueOnce({
        success: false,
        error: {
          kind: 'wrongAccount',
          message: "This invite is for h•••@gmail.com. You're signed in as x@y.com.",
          invitedHint: 'h•••@gmail.com',
          signedInAs: 'x@y.com',
        },
      })
      .mockResolvedValueOnce({ success: true, data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true } });
    await render();
    expect(document.body.querySelector('[data-testid="deep-link-invited-email"]')?.textContent).toBe(
      'This invite is for h•••@gmail.com.'
    );

    await act(async () => click(buttonNamed('Join')!));
    await flush();
    expect(dialog()?.dataset.phase).toBe('error');
    expect(dialog()?.textContent).toContain("This invite is for h•••@gmail.com. You're signed in as x@y.com.");

    await act(async () => click(buttonNamed('Sign in with another account')!));
    await flush();
    await flush();
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.login).toHaveBeenCalled();
    expect(mocks.accept).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(['/Rig/growth']);
  });

  it('without a sign-in, offers Sign in and resumes the join once it finishes', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    mocks.accept
      .mockResolvedValueOnce({
        success: false,
        error: { kind: 'notSignedIn', message: 'Not signed in' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true },
      });
    await render();

    await act(async () => click(buttonNamed('Join')!));
    await flush();
    expect(dialog()?.dataset.phase).toBe('signIn');
    expect(dialog()?.textContent).toContain('Sign in to join #growth.');

    await act(async () => click(buttonNamed('Sign in')!));
    await flush();
    await flush();

    expect(mocks.login).toHaveBeenCalled();
    expect(mocks.accept).toHaveBeenCalledTimes(2);
    expect(opened).toEqual(['/Rig/growth']);
  });

  it('a sign-in that finishes after Not now joins nothing', async () => {
    mocks.consumePending.mockResolvedValue({ link: LINK });
    mocks.accept.mockResolvedValue({
      success: false,
      error: { kind: 'notSignedIn', message: 'Not signed in' },
    });
    const finished = deferred<unknown>();
    mocks.awaitLogin.mockReturnValue(finished.promise);
    await render();

    await act(async () => click(buttonNamed('Join')!));
    await flush();
    await act(async () => click(buttonNamed('Sign in')!));
    await flush();
    await act(async () => click(buttonNamed('Not now')!));
    await flush();
    expect(dialog()).toBeNull();
    expect(mocks.cancelLogin).toHaveBeenCalled();

    await act(async () => finished.resolve({ success: true, data: null }));
    await flush();
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);
  });

  it('releases live delivery on unmount', async () => {
    await render();
    await act(async () => root.unmount());
    expect(mocks.release).toHaveBeenCalled();
    root = createRoot(host); // afterEach unmounts again
  });
});
