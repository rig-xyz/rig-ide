import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RIG_SETTINGS, type RigSettings } from '@shared/rig/settings';

/**
 * The window's first screen, by Rig Alpha: off, a new install gets the
 * current release's onboarding and never the first run (nor anything it
 * would do: no read, no Home space); on, the first run, which Not now leaves
 * for Home and over which Settings still opens.
 */

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  calls: [] as string[],
  listeners: new Map<string, Set<(data: unknown) => void>>(),
}));

// Every rpc call answers, so the whole App can mount: settings and the auth status as given,
// the agents empty, everything else nothing. Each call's path is kept, to say what never ran.
vi.mock('@renderer/lib/ipc', () => {
  const answer = (path: string, args: unknown[]): unknown => {
    switch (path) {
      case 'rig.settings.importLegacy':
      case 'rig.settings.get':
        return mocks.settings;
      case 'rig.settings.set':
        Object.assign(mocks.settings, args[0] as object);
        // As main does: every window hears the change.
        for (const listener of mocks.listeners.get('rig:settings-changed') ?? []) listener({ ...mocks.settings });
        return mocks.settings;
      case 'rig.auth.status':
        return { signedIn: false };
      case 'agents.list':
      case 'agents.listMetadata':
        return [];
      default:
        return undefined;
    }
  };
  const node = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_t, key) => (typeof key === 'string' ? node(path ? `${path}.${key}` : key) : undefined),
      apply: (_t, _this, args: unknown[]) => {
        mocks.calls.push(path);
        return Promise.resolve(answer(path, args));
      },
    });
  const on = (channel: { name: string }, listener: (data: unknown) => void) => {
    const set = mocks.listeners.get(channel.name) ?? new Set();
    set.add(listener);
    mocks.listeners.set(channel.name, set);
    return () => set.delete(listener);
  };
  return { rpc: node(''), events: { on, emit: () => {} } };
});

import { App } from '@renderer/App';
import { FIRST_RUN_CASES, replayFirstRun, stopSimulating } from '@renderer/features/first-run/debug/first-run-debug';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
const mount = async (settings: Partial<RigSettings>) => {
  mocks.settings = { ...DEFAULT_RIG_SETTINGS, ...settings };
  mocks.calls = [];
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App />
      </QueryClientProvider>
    );
  });
};
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'height:800px;width:1200px';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const byText = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));

describe('the first screen with Rig Alpha off', () => {
  it('a new install gets the current onboarding, not the first run', async () => {
    await mount({ alphaEnabled: false, hasSeenOnboarding: false, firstRunSeen: 0 });
    await vi.waitFor(() => expect(host.textContent).toMatch(/agent/i));
    expect(q('[data-testid="first-run-get-started"]')).toBeNull();
    expect(q('[data-testid="first-run-settings"]')).toBeNull();
    // Nothing of the first run's ran: no read, no Home space, no catch-up.
    expect(mocks.calls.filter((c) => c.startsWith('rig.orch'))).toEqual([]);
  });

  it('someone who has seen it goes straight to the app', async () => {
    await mount({ alphaEnabled: false, hasSeenOnboarding: true, firstRunSeen: 0 });
    await vi.waitFor(() => expect(mocks.calls).toContain('rig.auth.status'));
    expect(q('[data-testid="first-run-get-started"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Get started/);
  });
});

describe('the first run with Rig Alpha on', () => {
  it('replaces the onboarding, and Settings opens over it', async () => {
    await mount({ alphaEnabled: true, hasSeenOnboarding: false, firstRunSeen: 0 });
    await vi.waitFor(() => expect(q('[data-testid="first-run-get-started"]')).not.toBeNull());
    await act(async () => q('[data-testid="first-run-settings"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Advanced');
    // Portalled after the first run, at its layer (z-50): on top of it.
    expect(dialog.compareDocumentPosition(q('[data-testid="first-run-settings"]')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('Not now on Set up leaves for Home, and the first run stays closed', async () => {
    await mount({ alphaEnabled: true, hasSeenOnboarding: false, firstRunSeen: 0 });
    await vi.waitFor(() => expect(q('[data-testid="first-run-get-started"]')).not.toBeNull());
    await act(async () => q('[data-testid="first-run-get-started"]')!.click());
    await vi.waitFor(() => expect(q('[data-testid="first-run-not-now"]')).not.toBeNull());
    expect(byText(/^Continue$/)).toBeTruthy();
    await act(async () => q('[data-testid="first-run-not-now"]')!.click());
    await vi.waitFor(() => expect(q('[data-testid="first-run-setup-rows"]')).toBeNull(), { timeout: 3000 });
    expect(mocks.settings.firstRunSeen).toBeGreaterThan(0);
    expect(mocks.settings.hasSeenOnboarding).toBe(true);
    // Not the main onboarding either: Home.
    expect(q('[data-testid="first-run-get-started"]')).toBeNull();
  });
});

// Last: a replay is this window's (`useFirstRunDebug`).
describe('a simulated replay', () => {
  it('with Rig Alpha off, only simulates: nothing real is read, made or written', async () => {
    await mount({ alphaEnabled: false, hasSeenOnboarding: true, firstRunSeen: 1, debugMode: true });
    await vi.waitFor(() => expect(mocks.calls).toContain('rig.auth.status'));
    mocks.calls = [];
    await act(async () => void replayFirstRun(FIRST_RUN_CASES[0]!.simulation));
    await vi.waitFor(() => expect(q('[data-testid="first-run-get-started"]')).not.toBeNull());
    expect(q('[data-testid="first-run-debug"]')!.textContent).toContain('simulated');
    expect(q('[data-testid="first-run-debug-real"]')).toBeNull();
    await act(async () => q('[data-testid="first-run-get-started"]')!.click());
    await vi.waitFor(() => expect(q('[data-testid="first-run-setup-rows"]')).not.toBeNull());
    expect(mocks.calls.filter((c) => /^rig\.(orch|firstRun|feed|account|auth)\b|^agents\./.test(c))).toEqual([]);
    // Left with Not now: it closes, and the real settings were never written.
    await act(async () => q('[data-testid="first-run-not-now"]')?.click());
    await vi.waitFor(() => expect(q('[data-testid="first-run-setup-rows"]')).toBeNull(), { timeout: 3000 });
    expect(mocks.calls).not.toContain('rig.settings.set');
    expect(mocks.settings.firstRunSeen).toBe(1);
  });

  it('with Rig Alpha off, Real writes nothing either: the flow still only simulates', async () => {
    const progress = { step: 'setup' as const, readStarted: false };
    await mount({ alphaEnabled: false, hasSeenOnboarding: true, firstRunSeen: 1, firstRunProgress: progress, debugMode: true });
    await vi.waitFor(() => expect(mocks.calls).toContain('rig.auth.status'));
    mocks.calls = [];
    await act(async () => void replayFirstRun(FIRST_RUN_CASES[0]!.simulation));
    await vi.waitFor(() => expect(q('[data-testid="first-run-get-started"]')).not.toBeNull());
    await act(async () => stopSimulating());
    await vi.waitFor(() => expect(q('[data-testid="first-run-debug"]')!.textContent).toContain('simulated'));
    expect(mocks.calls).not.toContain('rig.settings.set');
    expect(mocks.settings.firstRunSeen).toBe(1);
    expect(mocks.settings.firstRunProgress).toEqual(progress);
  });

  it('with Rig Alpha on, over a first run not yet seen, still writes nothing', async () => {
    await mount({ alphaEnabled: true, hasSeenOnboarding: true, firstRunSeen: 0, debugMode: true });
    await vi.waitFor(() => expect(q('[data-testid="first-run-get-started"]')).not.toBeNull());
    mocks.calls = [];
    await act(async () => void replayFirstRun(FIRST_RUN_CASES[0]!.simulation, 'setup'));
    await vi.waitFor(() => expect(q('[data-testid="first-run-not-now"]')).not.toBeNull());
    await act(async () => q('[data-testid="first-run-not-now"]')!.click());
    // The real first run, still unseen, comes back.
    await vi.waitFor(() => expect(q('[data-testid="first-run-get-started"]')).not.toBeNull(), { timeout: 3000 });
    expect(mocks.calls).not.toContain('rig.settings.set');
    expect(mocks.settings.firstRunSeen).toBe(0);
  });
});
