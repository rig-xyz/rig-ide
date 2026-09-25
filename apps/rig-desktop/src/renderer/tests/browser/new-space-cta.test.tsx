import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Polish round 2, lane F — Home's primary "New space" CTA (Dylan's
 * "Google-Meet style: boom, you're in") and the "Join with a link" field
 * beside it. One click generates a name and drives straight through
 * `onCreateSpace` (no dialog); the link field validates+normalizes what
 * was pasted and hands it to `rpc.app.openExternal` (mocked here) rather
 * than re-implementing accept/attach itself.
 */

const mocks = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: (...args: unknown[]) => mocks.openExternal(...args) },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { NewSpaceCta } from '@renderer/features/home/new-space-cta';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('NewSpaceCta', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.openExternal.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('creates a space with a generated, unique name on one click and opens it — no naming dialog', async () => {
    const created: string[] = [];
    const onCreateSpace = vi.fn(async (name: string) => {
      created.push(name);
      return null;
    });
    await act(async () => {
      root.render(<NewSpaceCta existingNames={new Set(['bright-harbor'])} onCreateSpace={onCreateSpace} />);
    });

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
    const onCreateSpace = vi.fn(async () => 'The space could not go live.');
    await act(async () => {
      root.render(<NewSpaceCta existingNames={new Set()} onCreateSpace={onCreateSpace} />);
    });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('New space'))!;
    await act(async () => click(button));
    expect(host.textContent).toContain('The space could not go live.');
  });

  it('"Join with a link" opens a valid invite link in the browser and clears the field', async () => {
    await act(async () => {
      root.render(<NewSpaceCta existingNames={new Set()} onCreateSpace={vi.fn()} />);
    });
    const input = host.querySelector<HTMLInputElement>('[aria-label="Join with a link"]')!;
    expect(input).toBeTruthy();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'https://userig.xyz/join/abc123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const joinButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Join')!;
    await act(async () => click(joinButton));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.openExternal).toHaveBeenCalledWith('https://userig.xyz/join/abc123');
    expect(input.value).toBe('');
  });

  it('rejects a pasted link that is not a rig invite link, without calling openExternal', async () => {
    await act(async () => {
      root.render(<NewSpaceCta existingNames={new Set()} onCreateSpace={vi.fn()} />);
    });
    const input = host.querySelector<HTMLInputElement>('[aria-label="Join with a link"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'not a link');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const joinButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Join')!;
    await act(async () => click(joinButton));

    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(host.textContent).toContain("doesn't look like a rig invite link");
  });
});
