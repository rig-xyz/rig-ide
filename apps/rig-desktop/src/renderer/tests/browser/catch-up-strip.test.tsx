import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * Home's morning catch-up strip: a short run shown compactly, from the Read
 * step's own model: since when, rolling counts, one live line, grey tiles;
 * then While you were away, and it fades. A catch-up that stopped keeps its
 * one fix.
 */

const asked = vi.hoisted(() => ({ catchUpNow: 0 }));

/** Every rpc call the strip doesn't need answers nothing much. */
vi.mock('@renderer/lib/ipc', () => {
  const deep = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, key: string) => deep([...path, key]),
      apply: async () => {
        if (path.join('.') === 'rig.orch.catchUpNow') {
          asked.catchUpNow += 1;
          return { success: true, data: { outcome: 'started' } };
        }
        // Lists (the agents) are empty; the rest says no.
        if (path[0] === 'agents' || path.at(-1) === 'needed') return [];
        return { success: false, error: { message: 'not here' } };
      },
    });
  return { rpc: deep([]), events: { on: () => () => {} } };
});

import { CatchUpStrip } from '@renderer/features/home-feed/catch-up-strip';
import { replaySource } from '@renderer/features/first-run/read/progress-source';

const run = 'run_c';
const since = new Date(Date.now() - 20 * 3_600_000).toISOString();
const start: OrchProgressEvent = { run, kind: 'start', trigger: 'catch-up', passes: 1, lookups: 20, lookbackDays: 3, since, t: 0 };
const line = (id: string, connector: string, label: string, status: 'running' | 'done' | 'handled' | 'for_you', t: number, extra = {}): OrchProgressEvent => ({
  run,
  kind: 'line',
  line: { id, connector, label, status, t, ...extra },
});

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'width:420px';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = async (events: OrchProgressEvent[], needsYou = 2) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CatchUpStrip needsYou={needsYou} source={replaySource(events)} />
      </QueryClientProvider>
    );
  });
};
const strip = () => host.querySelector<HTMLElement>('[data-testid="catch-up-strip"]');

describe('CatchUpStrip', () => {
  it('shows nothing until a catch-up starts', async () => {
    await render([]);
    expect(strip()).toBeNull();
  });

  it('says since when, reads with rolling counts and grey tiles, then sums up and fades', async () => {
    await render([
      start,
      line('a', 'slack', 'Reading #eng', 'running', 10),
      line('a', 'slack', 'Reading #eng', 'done', 30),
      line('b', 'linear', 'Listing issues you own', 'done', 40),
      line('o1', 'slack', 'Payout delay: Sam resolved it', 'handled', 50),
      line('o2', 'linear', 'LAR-91 needs you', 'for_you', 60, { ref: 'sit_new' }),
      { run, kind: 'card', ref: 'sit_new', fresh: true, t: 61 },
      line('o3', 'slack', 'Priya still waits', 'for_you', 62, { ref: 'sit_old', known: true }),
      { run, kind: 'card', ref: 'sit_old', fresh: false, t: 63 },
      { run, kind: 'end', ok: true, t: 2000 },
    ]);
    await vi.waitFor(() => expect(strip()).not.toBeNull());
    expect(strip()!.textContent).toMatch(/Catching you up since (yesterday|\d)/);
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="catch-up-tiles"] i').length).toBe(2), { timeout: 2000 });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="catch-up-summary"]')).not.toBeNull(), { timeout: 4000 });
    expect(strip()!.textContent).toContain('While you were away');
    // One new card (the other was on the Feed already), one let go, and what needs you now.
    expect(host.querySelector('[data-testid="catch-up-summary"]')!.textContent).toBe('1 new · 1 handled · 2 need you');
    await vi.waitFor(() => expect(strip()).toBeNull(), { timeout: 12_000 });
  }, 20_000);

  it('a catch-up that stopped says why and keeps its fix', async () => {
    await render([start, { run, kind: 'end', ok: false, error: "Rig can't reach the server.", problem: 'relay_unreachable', t: 5 }]);
    await vi.waitFor(() => expect(strip()?.textContent).toContain("Rig can't reach its server"));
    const fix = host.querySelector<HTMLButtonElement>('[data-testid="catch-up-fix"] button')!;
    expect(fix.textContent).toContain('Try again');
    await act(async () => fix.click());
    await vi.waitFor(() => expect(asked.catchUpNow).toBe(1));
  });

  it('a connector to reconnect is said while it reads on', async () => {
    await render([start, line('a', 'slack', 'Reading #eng', 'running', 10), { run, kind: 'problem', problem: 'connector_auth', connector: 'gmail', t: 12 }]);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="catch-up-reconnect"]')?.textContent).toContain('Gmail needs reconnecting'));
  });
});
