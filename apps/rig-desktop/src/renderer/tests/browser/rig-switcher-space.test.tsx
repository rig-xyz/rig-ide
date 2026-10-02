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
  rename: vi.fn(),
  summary: vi.fn(),
  setLevel: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: (...args: unknown[]) => mocks.authStatus(...args) },
      recent: { recentRigs: (...args: unknown[]) => mocks.recentRigs(...args) },
      account: { workspaces: (...args: unknown[]) => mocks.workspaces(...args) },
      spaceSetup: { start: (...args: unknown[]) => mocks.createSpace(...args), list: async () => [] },
      files: { releaseRoot: (...args: unknown[]) => mocks.releaseRoot(...args) },
      control: { rename: (...args: unknown[]) => mocks.rename(...args) },
      notifications: {
        summary: (...args: unknown[]) => mocks.summary(...args),
        setLevel: (...args: unknown[]) => mocks.setLevel(...args),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { RigSwitcher } from '@renderer/features/shell/rig-switcher';
import { onOpenSetupRequest } from '@renderer/features/spaces/space-setup-store';
import { levelLabel } from '@shared/rig/notifications';

function summaryWith(level: 'all' | 'mentions' | 'nothing') {
  return {
    spaces: [
      {
        bindingId: 'space-1',
        name: 'growth',
        latestDirect: null,
        level,
        lastReadSeq: 0,
        spaceUnread: 0,
        directUnread: 0,
        directUnreadNoMessage: 0,
      },
    ],
    invitesUnread: 0,
    directUnreadTotal: 0,
  };
}

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
    mocks.summary.mockReset().mockResolvedValue(summaryWith('all'));
    mocks.setLevel.mockReset().mockResolvedValue({ success: true, data: null });
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

  it('"New space" starts one with a generated name and opens its Room at once', async () => {
    mocks.createSpace.mockResolvedValue({
      success: true,
      data: {
        id: 'setup-1',
        name: 'bright-harbor',
        path: '/rigs/bright-harbor',
        status: 'working',
        step: 'goingLive',
        bindingId: null,
        homeUrl: null,
        error: null,
        removable: true,
      },
    });
    const openedSetups: string[] = [];
    const off = onOpenSetupRequest((id) => openedSetups.push(id));
    const { onOpenPath } = await openMenu({ isSpace: true });
    const newSpace = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New space')!;
    await act(async () => click(newSpace));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.createSpace).toHaveBeenCalledTimes(1);
    const call = mocks.createSpace.mock.calls[0]![0];
    expect(call.name).toMatch(/^[a-z]+-[a-z]+$/);
    // Never collides with a space this account already has.
    expect(['growth', 'ops']).not.toContain(call.name);
    // Its Room opens now (App), while it's set up in the background.
    expect(openedSetups).toEqual(['setup-1']);
    expect(onOpenPath).not.toHaveBeenCalled();
    off();
  });

  it('"Rename…" puts the space\'s name in edit mode in place, and saving renames it', async () => {
    mocks.rename.mockResolvedValue({ success: true, data: { name: 'growth team' } });
    await openMenu({ isSpace: true });
    const rename = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Rename…')!;
    await act(async () => click(rename));
    const input = host.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('growth');

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'growth team');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.rename).toHaveBeenCalledWith({ bindingId: 'space-1', path: '/rigs/growth', name: 'growth team' });
    expect(host.textContent).toContain('growth team');
  });

  it('double-clicking the name also renames it in place', async () => {
    await openMenu({ isSpace: true });
    const trigger = host.querySelector('button')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('growth');
  });

  it('a plain rig keeps the unfiltered menu with "Open folder…", no space-only items', async () => {
    await openMenu({ isSpace: false });

    expect(document.body.textContent).toContain('scratch');
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('Open folder…');
    expect(buttons.some((t) => t === 'New space')).toBe(false);
    expect(buttons.some((t) => t === 'All spaces')).toBe(false);
  });

  describe('the space\'s notification level', () => {
    const menuButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
    const levelRows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];

    it('lives in the space\'s menu as "Notifications ›", the three levels in a submenu with the current one checked', async () => {
      mocks.summary.mockResolvedValue(summaryWith('mentions'));
      await openMenu({ isSpace: true });
      const item = menuButton('Notifications')!;
      expect(item).toBeTruthy();
      expect(item.getAttribute('aria-haspopup')).toBe('menu');
      await act(async () => click(item));

      const rows = levelRows();
      // The same words as Settings › Notifications and the space card's row.
      expect(rows.map((r) => r.textContent?.trim())).toEqual(['all', 'mentions', 'nothing'].map((l) => levelLabel(l as 'all')));
      expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    });

    it('sets the same per-space level the card row does, then closes the menu', async () => {
      await openMenu({ isSpace: true });
      await act(async () => click(menuButton('Notifications')!));
      const nothing = levelRows().find((r) => r.textContent?.trim() === 'Nothing')!;
      await act(async () => click(nothing));
      await act(async () => {
        await Promise.resolve();
      });

      expect(mocks.setLevel).toHaveBeenCalledWith({ bindingId: 'space-1', level: 'nothing' });
      expect(levelRows()).toHaveLength(0);
      expect(menuButton('Rename…')).toBeUndefined();
    });

    it('shows a small muted bell beside the space\'s name only while the level isn\'t All', async () => {
      await openMenu({ isSpace: true });
      expect(host.querySelector('[data-testid="space-notify-level-indicator"]')).toBeNull();

      mocks.summary.mockResolvedValue(summaryWith('nothing'));
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      const indicator = host.querySelector<HTMLElement>('[data-testid="space-notify-level-indicator"]')!;
      expect(indicator).not.toBeNull();
      expect(indicator.getAttribute('aria-label')).toBe(`Notifications: ${levelLabel('nothing')}`);
      expect(indicator.className).toContain('text-text-muted');
      // Beside the name, inside the breadcrumb's own trigger.
      expect(indicator.closest('button')?.textContent).toContain('growth');
    });

    it('is not offered for a plain rig', async () => {
      mocks.summary.mockResolvedValue(summaryWith('nothing'));
      await openMenu({ isSpace: false, bindingId: 'space-1' });
      expect(menuButton('Notifications')).toBeUndefined();
      expect(host.querySelector('[data-testid="space-notify-level-indicator"]')).toBeNull();
    });
  });
});
