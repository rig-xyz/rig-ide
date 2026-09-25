import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Polish round 2, lane F — Home's primary "New space" CTA (Dylan's
 * "Google-Meet style: boom, you're in") and the "Join with a link" field
 * beside it. One click generates a name and drives straight through
 * `onCreateSpace` (no dialog). Lane H: the link field now joins in the app
 * — `rpc.rig.share.acceptInviteLink`, then `rpc.rig.join.attach`, then
 * `onOpenPath` (all mocked here) — and only falls back to
 * `rpc.app.openExternal` without a usable sign-in.
 */

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  acceptInviteLink: vi.fn(),
  attach: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: (...args: unknown[]) => mocks.openExternal(...args) },
    rig: {
      share: { acceptInviteLink: (...args: unknown[]) => mocks.acceptInviteLink(...args) },
      join: { attach: (...args: unknown[]) => mocks.attach(...args) },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { NewSpaceCta } from '@renderer/features/home/new-space-cta';

const SECRET = 'tap_inv_s3cr3t';
const LINK = `https://userig.xyz/join/${SECRET}`;

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** A promise plus its resolver, to hold an RPC open while asserting the busy state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('NewSpaceCta', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    mocks.openExternal.mockReset().mockResolvedValue({ success: true });
    mocks.acceptInviteLink.mockReset();
    mocks.attach.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(props: Partial<React.ComponentProps<typeof NewSpaceCta>> = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewSpaceCta existingNames={new Set()} onCreateSpace={vi.fn()} onOpenPath={vi.fn()} {...props} />
        </QueryClientProvider>
      );
    });
  }

  async function pasteAndJoin(text: string) {
    const input = host.querySelector<HTMLInputElement>('[aria-label="Join with a link"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const joinButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Join')!;
    await act(async () => click(joinButton));
    return input;
  }

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('creates a space with a generated, unique name on one click and opens it — no naming dialog', async () => {
    const created: string[] = [];
    const onCreateSpace = vi.fn(async (name: string) => {
      created.push(name);
      return null;
    });
    await render({ existingNames: new Set(['bright-harbor']), onCreateSpace });

    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('New space'))!;
    expect(button).toBeTruthy();
    // No text input for a name anywhere near the CTA — one click is the whole flow.
    expect(host.querySelector('input[aria-label="Space name"]')).toBeNull();

    await act(async () => click(button));

    expect(onCreateSpace).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^[a-z]+-[a-z]+$/);
    expect(created[0]).not.toBe('bright-harbor');
  });

  it('surfaces a failure from onCreateSpace without silently swallowing it', async () => {
    await render({ onCreateSpace: vi.fn(async () => 'The space could not go live.') });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('New space'))!;
    await act(async () => click(button));
    expect(host.textContent).toContain('The space could not go live.');
  });

  it('"Join with a link" accepts in the app, shows a busy state, then attaches and opens the space', async () => {
    const accept = deferred<unknown>();
    mocks.acceptInviteLink.mockReturnValue(accept.promise);
    mocks.attach.mockResolvedValue({
      success: true,
      data: { localPath: '/Users/me/Rig/growth', rigName: 'growth', syncing: true },
    });
    const onOpenPath = vi.fn();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await render({ onOpenPath });

    const input = await pasteAndJoin(LINK);

    // Busy while the accept is in flight: the field and button lock, the button says so.
    expect(mocks.acceptInviteLink).toHaveBeenCalledWith({ link: LINK });
    expect(input.disabled).toBe(true);
    const busy = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Joining…'));
    expect(busy?.disabled).toBe(true);

    await act(async () => {
      accept.resolve({ success: true, data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true } });
    });
    await flush();

    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b_1', name: 'growth' });
    expect(onOpenPath).toHaveBeenCalledWith('/Users/me/Rig/growth');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rig', 'account'] });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('falls back to opening the link in the browser when not signed in', async () => {
    mocks.acceptInviteLink.mockResolvedValue({
      success: false,
      error: { kind: 'notSignedIn', message: 'Not signed in to Rig Hub' },
    });
    await render();

    const input = await pasteAndJoin('userig.xyz/join/abc123');
    await flush();

    expect(mocks.openExternal).toHaveBeenCalledWith('https://userig.xyz/join/abc123');
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('shows the typed error inline (never the link itself) and keeps the paste to fix', async () => {
    mocks.acceptInviteLink.mockResolvedValue({
      success: false,
      error: { kind: 'expired', status: 400, message: 'This invite link has expired — ask for a new one.' },
    });
    const onOpenPath = vi.fn();
    await render({ onOpenPath });

    const input = await pasteAndJoin(LINK);
    await flush();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('This invite link has expired — ask for a new one.');
    expect(host.textContent).not.toContain(SECRET);
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(onOpenPath).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe(LINK);
  });

  it('says the join went through when only the local setup fails', async () => {
    mocks.acceptInviteLink.mockResolvedValue({
      success: true,
      data: { bindingId: 'b_1', spaceName: 'growth', becameMember: false },
    });
    mocks.attach.mockResolvedValue({ success: false, error: { kind: 'cliMissing', message: 'Could not run `rig`.' } });
    const onOpenPath = vi.fn();
    await render({ onOpenPath });

    await pasteAndJoin(LINK);
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('You joined #growth');
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it('rejects a pasted link that is not a rig invite link, without calling anything', async () => {
    await render();
    await pasteAndJoin('not a link');

    expect(mocks.acceptInviteLink).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(host.textContent).toContain("doesn't look like a rig invite link");
  });
});
