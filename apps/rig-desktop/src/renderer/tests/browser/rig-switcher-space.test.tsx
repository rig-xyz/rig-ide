import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Polish round 2, lane F — inside a space, `RigSwitcher`'s menu is
 * space-scoped: your spaces only (a plain rig in the same `recentRigs`
 * list must never leak in), then "New space" (one-click) and "All spaces"
 * (Home), and no "Open folder…" — a plain rig keeps today's unfiltered
 * menu with "Open folder…" unchanged.
 */

const mocks = vi.hoisted(() => ({
  authStatus: vi.fn(),
  recentRigs: vi.fn(),
  workspaces: vi.fn(),
  createSpace: vi.fn(),
  releaseRoot: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: (...args: unknown[]) => mocks.authStatus(...args) },
      recent: { recentRigs: (...args: unknown[]) => mocks.recentRigs(...args) },
      account: { workspaces: (...args: unknown[]) => mocks.workspaces(...args) },
      create: { create: (...args: unknown[]) => mocks.createSpace(...args) },
      files: { releaseRoot: (...args: unknown[]) => mocks.releaseRoot(...args) },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { RigSwitcher } from '@renderer/features/shell/rig-switcher';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('RigSwitcher', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    mocks.authStatus.mockReset().mockResolvedValue({ signedIn: true });
    mocks.recentRigs.mockReset().mockResolvedValue([
      { bindingId: 'space-1', name: 'growth', path: '/rigs/growth' },
      { bindingId: 'space-2', name: 'ops', path: '/rigs/ops' },
      { bindingId: 'rig-1', name: 'scratch', path: '/rigs/scratch' },
    ]);
    mocks.workspaces.mockReset().mockResolvedValue({
      success: true,
      data: [
        { id: 'space-1', name: 'growth', kind: 'space', lastSyncedAt: null, role: 'owner', createdAt: '2026-01-01' },
        { id: 'space-2', name: 'ops', kind: 'space', lastSyncedAt: null, role: 'owner', createdAt: '2026-01-01' },
        { id: 'rig-1', name: 'scratch', kind: 'rig', lastSyncedAt: null, role: 'owner', createdAt: '2026-01-01' },
      ],
    });
    mocks.createSpace.mockReset();
    mocks.releaseRoot.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function openMenu(props: Partial<React.ComponentProps<typeof RigSwitcher>> = {}) {
    const onOpenPath = vi.fn();
    const onOpenFolder = vi.fn();
    const onGoHome = vi.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RigSwitcher
            bindingId="space-1"
            path="/rigs/growth"
            name="growth"
            onOpenPath={onOpenPath}
            onOpenFolder={onOpenFolder}
            onGoHome={onGoHome}
            {...props}
          />
        </QueryClientProvider>
      );
    });
    const trigger = host.querySelector('button')!;
    await act(async () => click(trigger));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return { onOpenPath, onOpenFolder, onGoHome };
  }

  it('lists only your spaces, then "New space" and "All spaces" — no "Open folder…"', async () => {
    await openMenu({ isSpace: true });

    expect(document.body.textContent).toContain('growth');
    expect(document.body.textContent).toContain('ops');
    // The plain rig in the same recentRigs list must not leak into a space's menu.
    expect(document.body.textContent).not.toContain('scratch');

    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('New space');
    expect(buttons).toContain('All spaces');
    expect(buttons.some((t) => t === 'Open folder…')).toBe(false);
  });

  it('"All spaces" calls onGoHome', async () => {
    const { onGoHome } = await openMenu({ isSpace: true });
    const goHome = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'All spaces')!;
    await act(async () => click(goHome));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  it('"New space" creates one click with a generated name and opens it', async () => {
    mocks.createSpace.mockResolvedValue({
      success: true,
      data: { path: '/rigs/bright-harbor', rootId: 'root-1', rigName: 'bright-harbor', synced: true, homeUrl: null, syncError: null, docPath: null },
    });
    const { onOpenPath } = await openMenu({ isSpace: true });
    const newSpace = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New space')!;
    await act(async () => click(newSpace));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.createSpace).toHaveBeenCalledTimes(1);
    const call = mocks.createSpace.mock.calls[0]![0];
    expect(call.kind).toBe('space');
    expect(call.name).toMatch(/^[a-z]+-[a-z]+$/);
    // Never collides with a space this account already has.
    expect(['growth', 'ops']).not.toContain(call.name);
    expect(onOpenPath).toHaveBeenCalledWith('/rigs/bright-harbor');
  });

  it('a plain rig keeps the unfiltered menu with "Open folder…", no space-only items', async () => {
    await openMenu({ isSpace: false });

    expect(document.body.textContent).toContain('scratch');
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('Open folder…');
    expect(buttons.some((t) => t === 'New space')).toBe(false);
    expect(buttons.some((t) => t === 'All spaces')).toBe(false);
  });
});
