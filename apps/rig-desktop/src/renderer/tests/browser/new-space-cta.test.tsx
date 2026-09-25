import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

/**
 * Home's "New space" quick-create pill (Dylan's "Google-Meet style: boom,
 * you're in"): one click generates a name and drives straight through
 * `onCreateSpace` (no dialog). Hovering it oozes out a link bubble; clicking
 * that stretches the pill into an inline "Paste an invite link" field,
 * which joins in the app — `rpc.rig.share.acceptInviteLink`, then
 * `rpc.rig.join.attach`, then `onOpenPath` (all mocked here) — and only
 * falls back to `rpc.app.openExternal` without a usable sign-in.
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

  const pill = () => host.querySelector<HTMLElement>('[data-testid="new-space-cta"]')!;
  const linkBubble = () => host.querySelector<HTMLButtonElement>('button[aria-label="Join with a link"]');
  const linkInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Invite link"]');

  async function hover() {
    // React's onMouseEnter is driven by mouseover (it doesn't listen for the non-bubbling mouseenter).
    await act(async () => pill().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  }

  async function openJoinField() {
    await hover();
    await act(async () => click(linkBubble()!));
    return linkInput()!;
  }

  async function type(input: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function pasteAndJoin(text: string) {
    const input = await openJoinField();
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

  it('hovering the pill oozes out the link bubble (focusable only while it is out)', async () => {
    await render();
    expect(pill().dataset.out).toBeUndefined();
    expect(linkBubble()!.tabIndex).toBe(-1);

    await hover();

    expect(pill().dataset.out).toBe('true');
    expect(linkBubble()!.tabIndex).toBe(0);
    // Nothing to paste into yet: the pill is still "New space".
    expect(linkInput()).toBeNull();
    expect(host.textContent).toContain('New space');
  });

  it('clicking the link bubble morphs the pill into a focused "Paste an invite link" field', async () => {
    await render();
    const input = await openJoinField();

    expect(input).toBeTruthy();
    expect(input.placeholder).toBe('Paste an invite link');
    expect(document.activeElement).toBe(input);
    expect(pill().dataset.join).toBe('true');
    // The pill became the field: no "New space" button while it's open.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('New space'))).toBe(false);
    expect([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Join')?.disabled).toBe(true);
  });

  it('Escape collapses the field back into the "New space" pill', async () => {
    await render();
    const input = await openJoinField();
    await type(input, 'half a li');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(linkInput()).toBeNull();
    expect(pill().dataset.join).toBeUndefined();
    const newSpace = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('New space'));
    expect(newSpace).toBeTruthy();
    expect(document.activeElement).toBe(newSpace);
  });

  it('blurring the field while it is still empty collapses it', async () => {
    await render();
    const input = await openJoinField();
    await act(async () => input.blur());
    expect(linkInput()).toBeNull();
  });

  it('Enter in the field joins with the pasted link', async () => {
    mocks.acceptInviteLink.mockResolvedValue({
      success: true,
      data: { bindingId: 'b_1', spaceName: 'growth', becameMember: true },
    });
    mocks.attach.mockResolvedValue({
      success: true,
      data: { localPath: '/Users/me/Rig/growth', rigName: 'growth', syncing: false },
    });
    const onOpenPath = vi.fn();
    await render({ onOpenPath });
    const input = await openJoinField();
    await type(input, LINK);

    // A real Enter keypress in the focused field (implicit form submit).
    expect(document.activeElement).toBe(input);
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await flush();

    expect(mocks.acceptInviteLink).toHaveBeenCalledWith({ link: LINK });
    expect(onOpenPath).toHaveBeenCalledWith('/Users/me/Rig/growth');
    // Done: back to the "New space" pill.
    expect(linkInput()).toBeNull();
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
    // Joined and opened: the field collapses back into the "New space" pill.
    expect(input.isConnected).toBe(false);
    expect(linkInput()).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('falls back to opening the link in the browser when not signed in', async () => {
    mocks.acceptInviteLink.mockResolvedValue({
      success: false,
      error: { kind: 'notSignedIn', message: 'Not signed in to Rig Hub' },
    });
    await render();

    await pasteAndJoin('userig.xyz/join/abc123');
    await flush();

    expect(mocks.openExternal).toHaveBeenCalledWith('https://userig.xyz/join/abc123');
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(linkInput()).toBeNull();
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
