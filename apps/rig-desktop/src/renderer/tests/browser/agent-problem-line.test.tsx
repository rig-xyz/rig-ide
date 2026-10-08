import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared agent problem line (Home and a space's agent list): one line
 * per state, with its one button doing what it says.
 */

const mocks = vi.hoisted(() => ({
  agents: [] as unknown[],
  signInNeeded: false,
  update: vi.fn(async () => ({ success: true })),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { agents: { update: mocks.update, list: async () => mocks.agents, probeAll: async () => undefined } },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/chat/use-runnable-agents', () => ({
  useRunnableAgents: () => ({ data: mocks.agents }),
}));
vi.mock('@renderer/features/agents/use-agent-sign-in-needed', () => ({
  useAgentSignInNeeded: (id: string) => ({
    needed: mocks.signInNeeded,
    agent: mocks.agents.find((a) => (a as { id: string }).id === id) ?? null,
    loginMethod: { kind: 'cli-login', id: 'login' },
    markSignedIn: () => {},
  }),
}));
vi.mock('@renderer/features/agents/agent-sign-in-dialog', () => ({
  AgentSignInDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="sign-in-dialog" /> : null),
}));

import { AgentProblemLine } from '@renderer/features/agents/agent-problem-line';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const installation = (over: Record<string, unknown> = {}) => ({
  id: '/usr/local/bin/codex',
  realpath: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
  pathEntry: '/usr/local/bin/codex',
  isActive: true,
  manageable: true,
  provenance: { kind: 'npm', confidence: 'confirmed' },
  status: 'available',
  version: '0.160.1',
  latestVersion: '0.160.1',
  updateAvailable: false,
  ...over,
});
const codex = (over: Record<string, unknown> = {}, install: Record<string, unknown> = {}) => ({
  id: 'codex',
  name: 'Codex',
  icon: { variants: [] },
  status: 'available',
  version: '0.160.1',
  latestVersion: '0.160.1',
  installations: [installation(install)],
  used: { kind: 'auto' },
  installOptions: [],
  capabilities: { auth: { kind: 'none' } },
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.agents = [];
  mocks.signInNeeded = false;
  mocks.update.mockClear();
  mocks.toast.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = (props: Partial<Parameters<typeof AgentProblemLine>[0]> = {}) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentProblemLine agentId="codex" variant="home" {...props} />
      </QueryClientProvider>
    )
  );
const line = () => host.querySelector<HTMLElement>('[data-testid="agent-problem"]');

describe('AgentProblemLine', () => {
  it('shows nothing for a current, signed in agent', async () => {
    mocks.agents = [codex()];
    await render();
    expect(line()).toBeNull();
  });

  it('missing: Install opens the shared install offer for that agent', async () => {
    mocks.agents = [codex({ status: 'missing', version: null, installations: [] })];
    await render();
    expect(line()?.dataset.kind).toBe('missing');
    expect(line()?.textContent).toContain("Codex isn't installed on this Mac. Rig runs the codex CLI.");
    await act(async () => line()!.querySelector<HTMLButtonElement>('[data-testid="agent-problem-install"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-setup-dialog"]')?.textContent).toContain('Set up Codex'));
  });

  it('missing, in a space list that knows it: Install goes to the caller', async () => {
    mocks.agents = [codex()];
    const onInstall = vi.fn();
    await render({ variant: 'space', missing: true, onInstall });
    expect(line()?.dataset.kind).toBe('missing');
    await act(async () => line()!.querySelector<HTMLButtonElement>('[data-testid="agent-problem-install"]')!.click());
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it('missing is quiet where it is not worth a line', async () => {
    mocks.agents = [codex({ status: 'missing', version: null, installations: [] })];
    await render({ showMissing: false });
    expect(line()).toBeNull();
  });

  it('signed out: names the CLI and its version, and Sign in opens the sign-in dialog', async () => {
    mocks.agents = [codex()];
    mocks.signInNeeded = true;
    await render();
    expect(line()?.dataset.kind).toBe('signedOut');
    expect(line()?.textContent).toContain("Codex isn't signed in on this Mac. The codex CLI is 0.160.1.");
    await act(async () => line()!.querySelector<HTMLButtonElement>('[data-testid="agent-sign-in-button"]')!.click());
    expect(document.querySelector('[data-testid="sign-in-dialog"]')).not.toBeNull();
  });

  it("outdated, a copy Rig manages: Update runs Rig's update", async () => {
    mocks.agents = [codex({ version: '0.147.0' }, { version: '0.147.0' })];
    await render();
    expect(line()?.dataset.kind).toBe('outdated');
    expect(line()?.textContent).toContain('Codex is older than Rig is tested with. The codex CLI is 0.147.0. Rig is tested with 0.159.1 or newer.');
    await act(async () => line()!.querySelector<HTMLButtonElement>('[data-testid="agent-problem-update"]')!.click());
    expect(mocks.update).toHaveBeenCalledWith('codex');
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('outdated, a Homebrew copy: Update says how to update it', async () => {
    mocks.agents = [codex({ version: '0.147.0' }, { version: '0.147.0', provenance: { kind: 'homebrew', confidence: 'confirmed', managerRef: 'codex' } })];
    await render();
    await act(async () => line()!.querySelector<HTMLButtonElement>('[data-testid="agent-problem-update"]')!.click());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'Update Codex', description: 'Homebrew installed this copy. Update it with brew upgrade codex.' });
  });

  it('errored: names the CLI and its version, with Install', async () => {
    mocks.agents = [codex({ status: 'error' })];
    await render({ variant: 'space' });
    expect(line()?.dataset.kind).toBe('error');
    expect(line()?.textContent).toContain("Codex didn't start on this Mac. The codex CLI is 0.160.1.");
    expect(line()?.querySelector('[data-testid="agent-problem-install"]')).not.toBeNull();
  });
});
