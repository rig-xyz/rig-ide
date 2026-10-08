import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bell's notifications card: Turn on asks macOS, and when macOS shows
 * no prompt (an unsigned dev build), the card turns into the System
 * Settings one instead of doing nothing.
 */

const mocks = vi.hoisted(() => ({
  permission: 'notDetermined' as string,
  requestPermission: vi.fn(),
  openSystemSettings: vi.fn(async () => {}),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      notifications: {
        permission: async () => mocks.permission,
        requestPermission: () => mocks.requestPermission(),
        openSystemSettings: () => mocks.openSystemSettings(),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { PermissionCard } from '@renderer/features/notifications/activity-bell';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const card = () => document.querySelector<HTMLElement>('[data-testid="notification-permission-card"]');
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe('PermissionCard', () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(async () => {
    localStorage.clear();
    mocks.permission = 'notDetermined';
    mocks.requestPermission.mockReset();
    mocks.openSystemSettings.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionCard hasActivity noPromptAfterMs={60} />
        </QueryClientProvider>
      )
    );
    await wait(0);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('turns into the System Settings card when macOS never answers Turn on', async () => {
    expect(button('Turn on')).toBeTruthy();
    await act(async () => button('Turn on')!.click());
    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    expect(button('Open System Settings')).toBeUndefined();
    await wait(120);
    expect(card()?.textContent).toContain("macOS didn't ask about banners for rig. Turn them on in System Settings.");
    await act(async () => button('Open System Settings')!.click());
    expect(mocks.openSystemSettings).toHaveBeenCalled();
  });

  it('goes away when macOS allows banners after Turn on', async () => {
    await act(async () => button('Turn on')!.click());
    mocks.permission = 'authorized';
    await act(async () => client.invalidateQueries({ queryKey: ['rig', 'notifications', 'permission'] }));
    await wait(120);
    expect(card()).toBeNull();
  });
});
