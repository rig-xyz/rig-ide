import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIconAsset, AgentPayload } from '@shared/core/agents/agent-payload';

/**
 * Settings cleanup round: section headers move off the onboarding-borrowed
 * mono/uppercase treatment, and the Agents list narrows to Rig's own two
 * harnesses (Claude, Codex) with a plain status pill — see
 * `settings-modal.tsx`'s own `Section`/`AgentsSection`/`PrimaryAgentRow`
 * comments for the reasoning. `Dialog` (Base UI) portals its content to
 * `document.body`, not the mount host, so assertions below read off
 * `document` rather than the mounted `host`.
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
// A third catalog entry, neither Claude nor Codex — exercises the "More
// agents" disclosure, which only appears once something is actually
// collapsed behind it.
const gemini = agentPayload('gemini', 'Gemini', 'missing');

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
    },
    agents: {
      list: async () => [claude, codex, gemini],
      listMetadata: async () => [claude, codex, gemini],
    },
    telemetry: { isUserEnabled: async () => true, setEnabled: async () => {} },
    app: { getAppVersion: async () => '0.0.0-test' },
    update: { isSupported: async () => false, getState: async () => ({ success: false }) },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { SettingsModal } from '@renderer/features/shell/settings-modal';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SettingsModal', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderSettings() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsModal open onOpenChange={() => {}} themePreference="system" onSetThemePreference={() => {}} />
        </QueryClientProvider>
      );
    });
    // Every settings query above resolves synchronously-ish; let them land.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('"Open spaces instantly" turns the disk cache on, and turning it off deletes what was kept', async () => {
    settingsMock.current = {};
    settingsMock.set.mockClear();
    settingsMock.clearRoomCache.mockClear();
    await renderSettings();
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
    settingsMock.current = {};
  });

  it('"Room themes" is off by default and the toggle saves roomThemesEnabled', async () => {
    settingsMock.current = {};
    settingsMock.set.mockClear();
    await renderSettings();
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
    settingsMock.current = {};
  });

  it('renders section headers in the regular font, sentence case, not mono/uppercase', async () => {
    await renderSettings();
    const labels = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="settings-section-label"]'));
    expect(labels.length).toBeGreaterThanOrEqual(7);
    const texts = labels.map((l) => l.textContent);
    expect(texts).toEqual(
      expect.arrayContaining(['Appearance', 'Account', 'Agents', 'Rig folder', 'Privacy', 'Experimental', 'About'])
    );
    for (const label of labels) {
      // Sentence case text, and no mono/uppercase treatment on the element itself.
      expect(label.className).not.toContain('uppercase');
      expect(label.className).not.toContain('font-mono');
      expect(label.textContent).not.toEqual(label.textContent?.toUpperCase());
    }
  });

  it('lists both Claude and Codex with a plain status pill, not the mono "SIGNED IN"/"INSTALLED" style', async () => {
    await renderSettings();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="primary-agent-row"]'));
    expect(rows.map((r) => r.dataset.agentId).sort()).toEqual(['claude', 'codex']);
    expect(document.body.textContent).toContain('Claude');
    expect(document.body.textContent).toContain('Codex');

    const pills = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="agent-status-pill"]'));
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.className).not.toContain('font-mono');
      expect(pill.className).not.toContain('uppercase');
      // Sentence case ("Not installed"), never the old shouty "NOT INSTALLED".
      expect(pill.textContent).not.toEqual(pill.textContent?.toUpperCase());
    }
  });

  it('replaces "+N more available" with a quiet "More agents" disclosure', async () => {
    await renderSettings();
    expect(document.body.textContent).not.toContain('more available');
    const moreButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'More agents');
    expect(moreButton).toBeTruthy();
  });
});
