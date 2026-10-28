import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Agent step once one agent is found: the other of Claude and Codex is
 * still offered, as a quiet Install row under the ready one.
 */

const ICON = { kind: 'svg' as const, variants: [{ minSize: 0, light: '<svg></svg>' }] };
const NO_AUTH = { auth: { kind: 'none' } };
const mocks = vi.hoisted(() => ({
  install: vi.fn(async (_id: string, _c?: string, _m?: string): Promise<unknown> => ({ success: true, data: {} })),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toasts: [] }) }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      list: async () => [
        { id: 'claude', name: 'Claude Code', status: 'available', version: '2.1.160', icon: ICON, capabilities: NO_AUTH, installOptions: [] },
        {
          id: 'codex',
          name: 'Codex',
          status: 'missing',
          icon: ICON,
          capabilities: NO_AUTH,
          installOptions: [
            { method: 'npm', command: 'npm install -g @openai/codex', missingTool: 'npm' },
            { method: 'curl', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', recommended: true },
          ],
        },
        { id: 'amp', name: 'Amp', status: 'missing', icon: ICON, capabilities: NO_AUTH, installOptions: [{ method: 'npm', command: 'npm i -g amp' }] },
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

describe('AgentsStep with Claude found and Codex missing', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.install.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('offers Codex in a quiet Install row, and only the space agents', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AgentsStep onComplete={() => {}} />
        </QueryClientProvider>
      );
    });
    const row = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-testid="agent-install-quiet"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(row.dataset.agentId).toBe('codex');
    expect(host.querySelectorAll('[data-testid="agent-install-quiet"]')).toHaveLength(1);
    expect(host.textContent).toContain('Claude Code');
    const install = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Install')!;
    await act(async () => install.click());
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledWith('codex', undefined, 'curl'));
  });
});
