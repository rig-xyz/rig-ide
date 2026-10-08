import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIconAsset, AgentPayload } from '@shared/core/agents/agent-payload';

/**
 * Settings, one page per topic (board 23): a sheet with a rail of pages,
 * one page at a time, search across every page. `Dialog` (Base UI) portals
 * its content to `document.body`, not the mount host, so assertions below
 * read off `document`.
 */

const svgIcon: AgentIconAsset = { kind: 'svg', variants: [{ minSize: 0, light: '<svg></svg>' }] };

function agentPayload(id: string, name: string, status: 'available' | 'missing'): AgentPayload {
  return {
    id,
    name,
    description: '',
    websiteUrl: '',
    icon: svgIcon,
    capabilities: {
      acp: { kind: 'supported' },
      auth: { kind: 'none' },
      hostDependency: {},
      models: { kind: 'none' },
      effort: { kind: 'none' },
      prompt: { kind: 'none' },
      sessions: { kind: 'none' },
      autoApprove: { kind: 'none' },
      hooks: { kind: 'none' },
      mcp: { kind: 'none' },
      plugins: { kind: 'none' },
    },
    installDocs: null,
    status,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    command: null,
    installations: [],
    used: 'auto',
    usedId: '',
    installOptions: [],
    settings: {},
  } as unknown as AgentPayload;
}

const claude = agentPayload('claude', 'Claude', 'available');
const codex = agentPayload('codex', 'Codex', 'missing');
// A third catalog entry, neither Claude nor Codex: exercises the "More
// agents" disclosure, which only appears once something is collapsed behind it.
const gemini = agentPayload('gemini', 'Gemini', 'missing');

const agentsUpdateMock = vi.hoisted(() => vi.fn(async (_id: string) => ({ success: true })));
const agentsInstallMock = vi.hoisted(() => vi.fn(async (_id: string, _c?: string, _m?: string) => ({ success: true, data: {} })));

const settingsMock = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  set: vi.fn(async (_patch: Record<string, unknown>) => ({})),
  clearRoomCache: vi.fn(async () => {}),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: async () => ({ signedIn: false }) },
      account: { me: async () => ({ success: false, error: { message: 'signed out' } }) },
      settings: { get: async () => settingsMock.current, set: settingsMock.set },
      roomCache: { clear: settingsMock.clearRoomCache },
      home: { get: async () => ({ home: '/home/test/Rig', displayPath: '~/Rig' }) },
      bundledCli: { getVersionReport: async () => ({ rig: undefined, tapd: undefined }) },
      notifications: {
        summary: async () => ({ spaces: [], directUnreadTotal: 0 }),
        permission: async () => 'authorized',
      },
      pages: { signIns: async () => ({ connection: null, browsers: [], sites: [], keepInStep: false }) },
    },
    agents: {
      list: async () => [claude, codex, gemini],
      listMetadata: async () => [claude, codex, gemini],
      update: agentsUpdateMock,
      install: agentsInstallMock,
    },
    telemetry: {
      isUserEnabled: async () => false,
      setEnabled: async () => {},
      isErrorReportsEnabled: async () => true,
      setErrorReportsEnabled: async () => {},
    },
    app: { getAppVersion: async () => '0.0.0-test' },
    update: { isSupported: async () => false, getState: async () => ({ success: false }) },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { SettingsSheet } from '@renderer/features/settings/settings-sheet';
import type { SettingsPageId } from '@renderer/features/settings/settings-pages';

const LAST_PAGE_KEY = 'rig-settings-last-page';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SettingsSheet', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    settingsMock.current = {};
    settingsMock.set.mockClear();
    settingsMock.clearRoomCache.mockClear();
    localStorage.removeItem(LAST_PAGE_KEY);
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

  async function renderSettings({
    initialPage = null,
    onOpenChange = () => {},
  }: { initialPage?: SettingsPageId | null; onOpenChange?: (open: boolean) => void } = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsSheet
            open
            onOpenChange={onOpenChange}
            themePreference="system"
            onSetThemePreference={() => {}}
            initialPage={initialPage}
          />
        </QueryClientProvider>
      );
    });
    await settle();
  }

  async function remount(initialPage: SettingsPageId | null = null) {
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderSettings({ initialPage });
  }

  async function typeSearch(text: string) {
    const search = document.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(search, text);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return search;
  }

  const currentPage = () => document.querySelector<HTMLElement>('[data-settings-current-page]')?.dataset.settingsCurrentPage;
  const pageTitle = () => document.getElementById('settings-page-title')?.textContent;
  const railButton = (id: SettingsPageId) => document.querySelector<HTMLButtonElement>(`[data-settings-page="${id}"]`)!;

  it('opens on General the first time, with every page in the rail and the version at its foot', async () => {
    await renderSettings();
    expect(currentPage()).toBe('general');
    expect(pageTitle()).toBe('General');
    expect(railButton('general').getAttribute('aria-current')).toBe('page');
    expect(railButton('general').className).toContain('glass-selected');
    const pages = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-page]')).map((b) => b.textContent);
    expect(pages).toEqual(['General', 'Account', 'Agents', 'Spaces', 'Notifications', 'Sign-ins', 'Privacy', 'Advanced', 'About']);
    expect(document.querySelector('[data-testid="settings-rail-version"]')?.textContent).toContain('0.0.0-test');
  });

  it('opens straight on the page it is given', async () => {
    await renderSettings({ initialPage: 'notifications' });
    expect(currentPage()).toBe('notifications');
    expect(pageTitle()).toBe('Notifications');
    expect(document.querySelector('[data-settings-row="quiet-while-using"]')).toBeTruthy();
  });

  it('Privacy has its own error reports switch, on even with usage data off', async () => {
    await renderSettings({ initialPage: 'privacy' });
    const usage = document.querySelector<HTMLButtonElement>('#telemetry-enabled');
    const errors = document.querySelector<HTMLButtonElement>('#error-reports-enabled');
    expect(document.querySelector('[data-settings-row="error-reports"]')?.textContent).toContain('Send error reports');
    expect(usage?.getAttribute('aria-checked')).toBe('false');
    expect(errors?.getAttribute('aria-checked')).toBe('true');
  });

  it('moves between pages from the rail, and remembers the last one for next time', async () => {
    await renderSettings();
    await act(async () => railButton('privacy').click());
    expect(currentPage()).toBe('privacy');
    expect(railButton('privacy').getAttribute('aria-current')).toBe('page');
    expect(railButton('general').getAttribute('aria-current')).toBeNull();
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBe('privacy');

    await remount();
    expect(currentPage()).toBe('privacy');
  });

  it('search filters rows across pages, and picking one jumps to its page and highlights the row', async () => {
    await renderSettings();
    const search = await typeSearch('dock');
    const results = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-result]'));
    expect(results.map((r) => r.dataset.settingsResult)).toEqual(['dock-badge']);
    expect(results[0]!.textContent).toContain('Notifications');

    await act(async () => results[0]!.click());
    await settle();
    expect(currentPage()).toBe('notifications');
    expect(search.value).toBe('');
    const row = document.querySelector<HTMLElement>('[data-settings-row="dock-badge"]')!;
    expect(row.dataset.highlighted).toBe('true');
    expect(row.className).toContain('bg-accent-subtle');
  });

  it('says so when nothing matches', async () => {
    await renderSettings();
    await typeSearch('zzzz nothing');
    expect(document.querySelector('[data-testid="settings-search-empty"]')).toBeTruthy();
  });

  it('Esc closes it', async () => {
    const onOpenChange = vi.fn();
    await renderSettings({ onOpenChange });
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalled());
    expect(onOpenChange.mock.calls[0]![0]).toBe(false);
  });

  it('"Ask before acting on comments" is on by default and is auto-approve shown the other way round', async () => {
    await renderSettings({ initialPage: 'agents' });
    const toggle = () => document.querySelector<HTMLButtonElement>('#ask-before-acting')!;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle().click());
    expect(settingsMock.set).toHaveBeenCalledWith({ autoApproveAgentActions: true });

    settingsMock.current = { autoApproveAgentActions: true };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    await act(async () => toggle().click());
    expect(settingsMock.set).toHaveBeenLastCalledWith({ autoApproveAgentActions: false });
  });

  it("what others see of your agent's work defaults to Steps and saves spacesRoomSeesDefault", async () => {
    await renderSettings({ initialPage: 'spaces' });
    const radios = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-settings-row="room-sees-default"] [role="radio"]'));
    const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;
    expect(radios().map((r) => r.textContent)).toEqual(['Answer', 'Steps', 'Everything']);
    expect(checked()).toBe('Steps');
    // What main will hand back once the pick is saved.
    settingsMock.current = { spacesRoomSeesDefault: 'answer' };
    await act(async () => radios()[0]!.click());
    expect(settingsMock.set).toHaveBeenCalledWith({ spacesRoomSeesDefault: 'answer' });
    await vi.waitFor(() => expect(checked()).toBe('Answer'));
  });

  it('chat view defaults to Flow and saves spacesChatView', async () => {
    await renderSettings({ initialPage: 'spaces' });
    const row = () => document.querySelector<HTMLElement>('[data-settings-row="chat-view"]')!;
    const radios = () => Array.from(row().querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;
    expect(row().textContent).toContain('Threads folds every reply under the message it answers. Flow keeps one timeline.');
    expect(radios().map((r) => r.textContent)).toEqual(['Flow', 'Threads']);
    expect(checked()).toBe('Flow');
    settingsMock.current = { spacesChatView: 'threads' };
    await act(async () => radios()[1]!.click());
    expect(settingsMock.set).toHaveBeenCalledWith({ spacesChatView: 'threads' });
    await vi.waitFor(() => expect(checked()).toBe('Threads'));
  });

  it('"Open spaces instantly" turns the disk cache on, and turning it off deletes what was kept', async () => {
    await renderSettings({ initialPage: 'advanced' });
    const toggle = () => document.querySelector<HTMLButtonElement>('#spaces-disk-cache')!;
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle().click());
    expect(settingsMock.set).toHaveBeenCalledWith({ spacesRoomDiskCache: true });
    expect(settingsMock.clearRoomCache).not.toHaveBeenCalled();

    settingsMock.current = { spacesRoomDiskCache: true };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    await act(async () => toggle().click());
    expect(settingsMock.set).toHaveBeenLastCalledWith({ spacesRoomDiskCache: false });
    await vi.waitFor(() => expect(settingsMock.clearRoomCache).toHaveBeenCalledOnce());
  });

  it('"Topics" saves roomThemesEnabled', async () => {
    await renderSettings({ initialPage: 'advanced' });
    const toggle = () => document.querySelector<HTMLButtonElement>('#room-themes-enabled')!;
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle().click());
    expect(settingsMock.set).toHaveBeenCalledWith({ roomThemesEnabled: true });

    settingsMock.current = { roomThemesEnabled: true };
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    await act(async () => toggle().click());
    expect(settingsMock.set).toHaveBeenLastCalledWith({ roomThemesEnabled: false });
  });

  it('has no Spaces on/off switch any more', async () => {
    await renderSettings({ initialPage: 'spaces' });
    expect(document.querySelector('#spaces-enabled')).toBeNull();
    await remount('advanced');
    expect(document.querySelector('#spaces-enabled')).toBeNull();
  });

  it('lists both Claude and Codex with a plain status pill, and the rest behind "More agents"', async () => {
    await renderSettings({ initialPage: 'agents' });
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="primary-agent-row"]'));
    expect(rows.map((r) => r.dataset.agentId).sort()).toEqual(['claude', 'codex']);
    const pills = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="agent-status-pill"]'));
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.className).not.toContain('font-mono');
      expect(pill.className).not.toContain('uppercase');
      expect(pill.textContent).not.toEqual(pill.textContent?.toUpperCase());
    }
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'More agents')).toBe(true);
  });

  it('offers Install under a Claude or Codex that is not installed, wired to the agent install', async () => {
    const before = { ...codex };
    Object.assign(codex, {
      installOptions: [{ method: 'installer-macos', command: 'brew install --cask codex', recommended: true }],
    });
    try {
      await renderSettings({ initialPage: 'agents' });
      const row = () => document.querySelector<HTMLElement>('[data-testid="agent-install-row"][data-agent-id="codex"]');
      await vi.waitFor(() => expect(row()).not.toBeNull());
      // Claude is installed: no install offer for it.
      expect(document.querySelector('[data-testid="agent-install-row"][data-agent-id="claude"]')).toBeNull();
      await act(async () => row()!.querySelector<HTMLButtonElement>('[data-testid="agent-install-installer-macos"]')!.click());
      await vi.waitFor(() => expect(agentsInstallMock).toHaveBeenCalledWith('codex', undefined, 'installer-macos'));
    } finally {
      Object.assign(codex, before);
    }
  });

  it('shows Update available under an outdated Codex, and Update runs the agent update', async () => {
    const npmCodex = {
      id: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      realpath: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      pathEntry: '/usr/local/bin/codex',
      isActive: true,
      manageable: true,
      provenance: { kind: 'npm', confidence: 'confirmed' },
      status: 'available',
      version: '0.159.5',
      latestVersion: '0.160.1',
      updateAvailable: true,
    };
    const before = { ...codex };
    Object.assign(codex, { status: 'available', installations: [npmCodex], used: { kind: 'auto' }, latestVersion: '0.160.1' });
    try {
      await renderSettings({ initialPage: 'agents' });
      const line = () => document.querySelector<HTMLElement>('[data-testid="agent-update-line"][data-agent-id="codex"]');
      await vi.waitFor(() => expect(line()?.textContent).toContain('Update available: 0.160.1. You have 0.159.5.'));
      const button = Array.from(line()!.querySelectorAll('button')).find((b) => b.textContent === 'Update');
      await act(async () => button!.click());
      expect(agentsUpdateMock).toHaveBeenCalledWith('codex');
    } finally {
      Object.assign(codex, before);
    }
  });

  it('says when Codex is older than Rig is tested with, in place of Update available', async () => {
    const npmCodex = {
      id: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      realpath: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      pathEntry: '/usr/local/bin/codex',
      isActive: true,
      manageable: true,
      provenance: { kind: 'npm', confidence: 'confirmed' },
      status: 'available',
      version: '0.147.0',
      latestVersion: '0.160.1',
      updateAvailable: true,
    };
    const before = { ...codex };
    Object.assign(codex, { status: 'available', installations: [npmCodex], used: { kind: 'auto' }, latestVersion: '0.160.1' });
    try {
      await renderSettings({ initialPage: 'agents' });
      const line = () => document.querySelector<HTMLElement>('[data-testid="agent-minimum-line"][data-agent-id="codex"]');
      await vi.waitFor(() =>
        expect(line()?.textContent).toContain('Codex is older than Rig is tested with. The codex CLI is 0.147.0. Rig is tested with 0.159.1 or newer.')
      );
      expect(document.querySelector('[data-testid="agent-update-line"][data-agent-id="codex"]')).toBeNull();
      const button = Array.from(line()!.querySelectorAll('button')).find((b) => b.textContent === 'Update');
      await act(async () => button!.click());
      expect(agentsUpdateMock).toHaveBeenCalledWith('codex');
    } finally {
      Object.assign(codex, before);
    }
  });

  it('says a development build does not update itself, in About beside the version', async () => {
    await renderSettings({ initialPage: 'about' });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="updates-dev-build"]')?.textContent).toBe(
        "This development build doesn't update itself."
      )
    );
  });

  it('keeps every lede and fixed row free of dash-joined clauses, parentheses and "room"', async () => {
    const { SETTINGS_PAGES, SETTINGS_ROWS } = await import('@renderer/features/settings/settings-pages');
    const copy = [...SETTINGS_PAGES.map((p) => p.lede), ...SETTINGS_ROWS.flatMap((r) => [r.label, r.description])];
    for (const line of copy) {
      expect(line).not.toMatch(/ [—–-] |[()]/);
      expect(line).not.toMatch(/\broom\b/i);
    }
  });
});
