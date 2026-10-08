import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first-run Agent step on a clean Mac: Codex is offered through OpenAI's
 * own installer (no npm), with the ChatGPT app hint, and an install that
 * finishes but can't be found says why in the toast.
 */

const ICON = { kind: 'svg' as const, variants: [{ minSize: 0, light: '<svg></svg>' }] };
const NO_AUTH = { auth: { kind: 'none' } };
const mocks = vi.hoisted(() => ({
  install: vi.fn(async (_id: string, _c?: string, _m?: string): Promise<unknown> => ({ success: true, data: {} })),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast, useToast: () => ({ toasts: [] }) }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      list: async () => [
        {
          id: 'codex',
          name: 'Codex',
          status: 'missing',
          icon: ICON,
          capabilities: NO_AUTH,
          installOptions: [
            { method: 'npm', command: 'npm install -g @openai/codex', missingTool: 'npm' },
            { method: 'curl', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh', recommended: true },
            { method: 'homebrew', command: 'brew install --cask codex', missingTool: 'brew' },
          ],
        },
      ],
      listMetadata: async () => [],
      install: mocks.install,
      probeAll: async () => undefined,
    },
    app: { openExternal: async () => {} },
  },
  events: { on: () => () => {} },
}));

import { AgentsStep } from '@renderer/features/onboarding/agents-step';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('AgentsStep on a Mac without Node', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.install.mockClear();
    mocks.toast.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AgentsStep onComplete={() => {}} />
        </QueryClientProvider>
      );
    });
    return vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>('[data-testid="agent-install-row"][data-agent-id="codex"]');
      expect(row).not.toBeNull();
      return row!;
    });
  }

  it('offers only the way that needs no npm, and the ChatGPT app hint', async () => {
    const row = await mount();
    expect(row.textContent).toContain('chatgpt.com/codex/install.sh');
    expect(row.textContent).not.toContain('npm install');
    expect(row.textContent).not.toContain('brew install');
    expect(row.querySelector('[data-testid="codex-chatgpt-hint"]')?.textContent).toBe(
      'Already use the ChatGPT app? Sign in there and Rig will find Codex.'
    );
  });

  it('says why when the install finished but Codex can’t be found', async () => {
    mocks.install.mockResolvedValueOnce({ success: false, error: { type: 'not-detected-after-install', id: 'codex' } });
    const row = await mount();
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="agent-install-curl"]')!.click());
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledWith('codex', undefined, 'curl'));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Couldn’t install Codex',
        description: 'The install finished, but Rig can’t find Codex yet. Press Check again, or quit and reopen Rig.',
        variant: 'destructive',
      })
    );
  });
});
