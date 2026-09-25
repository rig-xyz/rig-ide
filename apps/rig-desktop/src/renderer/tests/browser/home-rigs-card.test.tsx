import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Polish round 2, lane F coverage for the Home "Rigs" card (Dylan: rename
 * from "Solo rigs", one "+ New" header action like the Spaces card, "Open"
 * removed). `home.tsx` wraps `RigsRail` in `FloatingCard` exactly this way
 * — this harness mirrors that composition rather than mounting the whole
 * `Home` (which needs a much larger RPC surface unrelated to this card).
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      settings: {
        get: async () => ({ rigsRailView: { filter: 'all', sort: 'recent' }, hiddenByRig: {} }),
        set: async () => {},
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { FloatingCard } from '@renderer/features/home/floating-card';
import type { HomeRigRow } from '@renderer/features/home/home-sections';
import { RigsRail } from '@renderer/features/home/rigs-rail';

function localRig(i: number): HomeRigRow {
  return {
    kind: 'local',
    bindingId: `b-${i}`,
    name: `rig-${String(i).padStart(2, '0')}`,
    path: `/Users/me/Rig/rig-${i}`,
    // Newest first under the default 'recent' sort: rig-00, rig-01, …
    lastOpenedAt: 1_000_000 - i,
    sessions: [],
    paused: false,
    outsideHome: false,
    notARigAnymore: false,
    role: 'owner',
  };
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Home "Rigs" card', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('titles itself "Rigs" (not "Solo rigs") with one "+ New" header action, and no "Open" action', async () => {
    const created: boolean[] = [];
    await act(async () => {
      root.render(
        <FloatingCard
          storageKey="test-rigs-card"
          title="Rigs"
          count={0}
          headerAction={
            <button type="button" onClick={() => created.push(true)}>
              + New
            </button>
          }
        >
          <RigsRail
            rows={[]}
            identities={new Map()}
            onOpenPath={() => {}}
            onOpenSession={() => {}}
          />
        </FloatingCard>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Rigs');
    expect(host.textContent).not.toContain('Solo rigs');

    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('+ New');
    expect(buttons.some((t) => t === 'Open')).toBe(false);
    expect(host.textContent).not.toContain('New rig');

    const newButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '+ New')!;
    await act(async () => click(newButton));
    expect(created).toEqual([true]);
  });

  it('caps the list at six rows with a "Show all N" that reveals the rest', async () => {
    const rows = Array.from({ length: 19 }, (_, i) => localRig(i));
    const rigNames = () =>
      [...host.querySelectorAll('span')].map((s) => s.textContent ?? '').filter((t) => /^rig-\d\d$/.test(t));
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RigsRail rows={rows} identities={new Map()} onOpenPath={() => {}} onOpenSession={() => {}} />
        </QueryClientProvider>
      );
    });

    expect(new Set(rigNames())).toEqual(new Set(['rig-00', 'rig-01', 'rig-02', 'rig-03', 'rig-04', 'rig-05']));
    const showAll = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Show all 19');
    expect(showAll).toBeDefined();
    // The filter/sort control stays.
    expect(host.textContent).toContain('All · Recent activity');

    await act(async () => click(showAll!));
    expect(new Set(rigNames()).size).toBe(19);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Show all'))).toBe(false);
  });

  it('lifts the cap when the highlighted rig sits past it', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => localRig(i));
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RigsRail
            rows={rows}
            identities={new Map()}
            onOpenPath={() => {}}
            onOpenSession={() => {}}
            highlightBindingId="b-8"
          />
        </QueryClientProvider>
      );
    });
    expect(host.textContent).toContain('rig-08');
    expect(host.textContent).not.toContain('Show all');
  });
});
